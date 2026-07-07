'use strict';

/**
 * Opt-in MCP server for nodemon.
 * When mcp is false (default), this module is never started from nodemon.js.
 *
 * HTTP mode (default with --mcp):
 *   REST (easiest to test — no MCP client required):
 *     GET  /health
 *     GET  /api/status | /api/watched | /api/history | /api/logs | /api/tools
 *     POST /api/restart | /api/quit
 *     POST /api/tools/<toolName>   body: JSON args object (optional)
 *   MCP SSE (for MCP clients that speak deprecated HTTP+SSE):
 *     GET  /mcp  (or /sse)  → SSE stream, session id in endpoint event
 *     POST /messages?sessionId=...
 *
 * Security (prod defaults):
 *   - Binds 127.0.0.1 by default
 *   - Non-loopback bind requires --mcpAllowRemote and --mcpToken
 *   - Optional --mcpToken required on all routes except GET /health when set
 *   - No Access-Control-Allow-Origin: * (no browser CSRF via open CORS)
 *   - JSON body size limited (1MB)
 *
 * stdio mode (--mcp-stdio):
 *   Full MCP over stdin/stdout. Prefer HTTP if you still want terminal logs.
 *
 * Lifecycle: stop() closes HTTP server, SSE transports, and unbinds bus state.
 * Called on nodemon reset/quit.
 */

var http = require('http');
var url = require('url');
var utils = require('../utils');
var config = require('../config');
var version = require('../version');
var state = require('./state');
var emitRestart = require('../monitor/restart-reason').emitRestart;

var mcpSdkServer = null;
var mcpSdkSse = null;
var mcpSdkStdio = null;

try {
  mcpSdkServer = require('@modelcontextprotocol/sdk/server/mcp.js');
  mcpSdkSse = require('@modelcontextprotocol/sdk/server/sse.js');
  mcpSdkStdio = require('@modelcontextprotocol/sdk/server/stdio.js');
} catch (e) {
  // leave null — HTTP REST still works; SSE/stdio need optional SDK
}

var MAX_BODY_BYTES = 1024 * 1024; // 1MB

/** @type {null|{name:string,description:string,handler:Function}[]} */
var toolDefs = null;

/** @type {null|import('http').Server} */
var activeHttpServer = null;
/** @type {Object.<string, object>} */
var activeSseTransports = Object.create(null);
var activeMode = null; // 'http' | 'stdio' | null
var quitHooked = false;

function textResult(obj) {
  return {
    content: [
      {
        type: 'text',
        text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

function defineTools(nodemonApi) {
  return [
    {
      name: 'nodemon_status',
      description:
        'Get nodemon runtime status (running/crashed/etc), pids, restart count, last crash, config summary',
      handler: async function () {
        return textResult(state.getSnapshot());
      },
    },
    {
      name: 'nodemon_watched_files',
      description:
        'List files currently tracked by the watcher (updated on add/unlink; capped)',
      handler: async function (args) {
        return textResult({
          count: state._state.watchedFiles.length,
          files: state.getWatchedFiles(args && args.limit),
        });
      },
    },
    {
      name: 'nodemon_restart_history',
      description: 'Recent restart history with reasons and files when available',
      handler: async function (args) {
        return textResult({
          restartCount: state._state.restartCount,
          history: state.getRestartHistory(args && args.limit),
        });
      },
    },
    {
      name: 'nodemon_last_crash',
      description:
        'Details of the most recent child process crash (null if none since MCP started)',
      handler: async function () {
        return textResult({
          lastCrash: state.getLastCrash(),
          status: state._state.status,
        });
      },
    },
    {
      name: 'nodemon_logs',
      description: 'Recent nodemon log lines (status/detail/error/etc)',
      handler: async function (args) {
        return textResult({
          logs: state.getLogs(args && args.limit, args && args.type),
        });
      },
    },
    {
      name: 'nodemon_config',
      description: 'Return a summary of the active nodemon configuration',
      handler: async function () {
        return textResult(state.getSnapshot().config || {});
      },
    },
    {
      name: 'nodemon_restart',
      description:
        'Trigger a nodemon restart of the child process (same as typing rs / API restart). Safe to call repeatedly.',
      handler: async function () {
        // Always go through emitRestart so history records trigger: mcp
        utils.log.status('restarting child process');
        emitRestart(undefined, { type: 'api', trigger: 'mcp' });
        return textResult({
          ok: true,
          action: 'restart',
          at: new Date().toISOString(),
        });
      },
    },
    {
      name: 'nodemon_quit',
      description:
        'Ask nodemon to quit (stops watching and exits the monitor). Response is sent before exit.',
      handler: async function () {
        setTimeout(function () {
          utils.bus.emit('quit');
        }, 50);
        return textResult({
          ok: true,
          action: 'quit',
          at: new Date().toISOString(),
        });
      },
    },
  ];
}

function buildMcpServer(nodemonApi) {
  var defs = defineTools(nodemonApi);
  toolDefs = defs;
  var McpServer = mcpSdkServer.McpServer;
  var server = new McpServer(
    {
      name: 'nodemon',
      version: (version.pinned || '0.0.0').toString(),
    },
    { capabilities: { tools: {} } }
  );

  defs.forEach(function (def) {
    // No zod schemas — avoid hard dep on transitive zod; tools accept free-form args
    server.tool(def.name, def.description, def.handler);
  });

  return server;
}

function listToolsJson() {
  var defs = toolDefs || defineTools(null);
  return defs.map(function (d) {
    return { name: d.name, description: d.description };
  });
}

async function invokeToolByName(name, args, nodemonApi) {
  var defs = toolDefs || defineTools(nodemonApi);
  var def = null;
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].name === name) {
      def = defs[i];
      break;
    }
  }
  if (!def) {
    var err = new Error('Unknown tool: ' + name);
    err.code = 'NOT_FOUND';
    throw err;
  }
  return def.handler(args || {});
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    var aborted = false;

    req.on('data', function (c) {
      if (aborted) {
        return;
      }
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        var err = new Error('Request body too large (max ' + MAX_BODY_BYTES + ' bytes)');
        err.code = 'PAYLOAD_TOO_LARGE';
        try {
          req.destroy();
        } catch (e) { /* ignore */ }
        return reject(err);
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (aborted) {
        return;
      }
      if (!chunks.length) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function mcpLog(message, useStdioQuiet) {
  if (useStdioQuiet) {
    try {
      process.stderr.write('[nodemon] ' + message + '\n');
    } catch (e) { /* ignore */ }
  } else {
    utils.log.info(message);
  }
}

function isLoopbackHost(host) {
  if (!host) {
    return true;
  }
  var h = String(host).toLowerCase();
  return (
    h === '127.0.0.1' ||
    h === '::1' ||
    h === 'localhost' ||
    h === '0:0:0:0:0:0:0:1'
  );
}

/**
 * When mcpToken is set, require it via Authorization: Bearer, X-Nodemon-Mcp-Token,
 * or ?token= query. GET /health is always open for liveness probes.
 */
function authorizeRequest(req, parsed, options, pathName) {
  var token = options && options.mcpToken;
  if (!token) {
    return true;
  }
  if (req.method === 'GET' && pathName === '/health') {
    return true;
  }

  var auth = (req.headers && req.headers.authorization) || '';
  var bearer = '';
  var m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m) {
    bearer = m[1].trim();
  }
  var headerToken =
    (req.headers && (req.headers['x-nodemon-mcp-token'] || req.headers['x-mcp-token'])) ||
    '';
  var queryToken =
    (parsed && parsed.query && (parsed.query.token || parsed.query.mcpToken)) || '';

  return bearer === token || headerToken === token || String(queryToken) === token;
}

function hookLifecycleOnce() {
  if (quitHooked) {
    return;
  }
  quitHooked = true;

  // Close MCP resources on quit / reset so ports and bus listeners do not leak.
  utils.bus.on('quit', function () {
    stop();
  });
  utils.bus.on('reset', function () {
    stop();
  });
}

/**
 * Close HTTP server, SSE transports, and reset MCP state. Safe to call repeatedly.
 * @param {Function} [cb]
 */
function stop(cb) {
  Object.keys(activeSseTransports).forEach(function (id) {
    try {
      var t = activeSseTransports[id];
      if (t && typeof t.close === 'function') {
        t.close();
      }
    } catch (e) { /* ignore */ }
    delete activeSseTransports[id];
  });

  var server = activeHttpServer;
  activeHttpServer = null;
  activeMode = null;
  toolDefs = null;

  function done() {
    try {
      state.resetState();
    } catch (e) { /* ignore */ }
    if (typeof cb === 'function') {
      cb();
    }
  }

  if (!server) {
    done();
    return;
  }

  try {
    var settled = false;
    function finish() {
      if (settled) {
        return;
      }
      settled = true;
      done();
    }
    server.close(finish);
    var t = setTimeout(finish, 2000);
    if (t && typeof t.unref === 'function') {
      t.unref();
    }
  } catch (e) {
    done();
  }
}

/**
 * @param {object} options nodemon options
 * @param {object} nodemonApi
 * @returns {Promise<object>}
 */
function start(options, nodemonApi) {
  options = options || {};
  hookLifecycleOnce();

  // Idempotent: already running
  if (activeMode === 'http' && activeHttpServer) {
    return Promise.resolve({
      transport: 'http',
      alreadyRunning: true,
    });
  }
  if (activeMode === 'stdio') {
    return Promise.resolve({
      transport: 'stdio',
      alreadyRunning: true,
    });
  }

  // Fresh bind of bus state (stop() may have cleared it)
  if (state._state && state._state.bound) {
    state.resetState();
  }
  state.bindBus(utils.bus, config);
  toolDefs = defineTools(nodemonApi);

  var transport = (options.mcpTransport || 'http').toString().toLowerCase();
  if (transport === 'true' || transport === '1') {
    transport = 'http';
  }

  if (transport === 'stdio') {
    if (!mcpSdkServer || !mcpSdkStdio) {
      mcpLog(
        'MCP SDK missing; install optional dep: npm install @modelcontextprotocol/sdk (Node >= 18)',
        true
      );
      return Promise.resolve({ transport: 'none', reason: 'sdk-missing' });
    }
    activeMode = 'stdio';
    var stdioServer = buildMcpServer(nodemonApi);
    var stdioTransport = new mcpSdkStdio.StdioServerTransport();
    return stdioServer.connect(stdioTransport).then(function () {
      mcpLog('MCP stdio transport connected (do not use stdout for app logs)', true);
      return { transport: 'stdio' };
    });
  }

  // HTTP mode works even if SDK fails to load — REST /api/* still available
  var port = parseInt(options.mcpPort, 10);
  if (!port || port < 1) {
    port = 8765;
  }
  var host = options.mcpHost || '127.0.0.1';
  var token = options.mcpToken || null;
  var allowRemote = !!options.mcpAllowRemote;
  var sseEnabled = !!(mcpSdkServer && mcpSdkSse);

  if (!isLoopbackHost(host)) {
    if (!allowRemote) {
      var msg =
        'MCP refused non-loopback bind (' +
        host +
        '). Use --mcpHost 127.0.0.1, or pass --mcpAllowRemote with --mcpToken.';
      utils.log.error(msg);
      return Promise.reject(new Error(msg));
    }
    if (!token) {
      var msg2 =
        'MCP remote bind requires --mcpToken when using --mcpAllowRemote (' +
        host +
        ').';
      utils.log.error(msg2);
      return Promise.reject(new Error(msg2));
    }
    utils.log.error(
      'MCP listening on non-loopback host ' +
        host +
        ' with token auth — treat as sensitive control plane'
    );
  }

  var httpServer = http.createServer(async function (req, res) {
    var parsed = url.parse(req.url, true);
    var pathName = parsed.pathname || '/';

    // No open CORS. Local tools (curl/agents) do not need browser cross-origin.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, X-Nodemon-Mcp-Token',
      });
      return res.end();
    }

    if (!authorizeRequest(req, parsed, options, pathName)) {
      return sendJson(res, 401, {
        error: 'unauthorized',
        hint: 'Pass Authorization: Bearer <mcpToken> or X-Nodemon-Mcp-Token header',
      });
    }

    try {
      if (req.method === 'GET' && pathName === '/health') {
        return sendJson(res, 200, {
          ok: true,
          mcp: true,
          sse: sseEnabled,
          auth: !!token,
          tools: listToolsJson().map(function (t) {
            return t.name;
          }),
        });
      }

      if (req.method === 'GET' && pathName === '/api/status') {
        return sendJson(res, 200, state.getSnapshot());
      }
      if (req.method === 'GET' && pathName === '/api/watched') {
        return sendJson(res, 200, {
          count: state._state.watchedFiles.length,
          files: state.getWatchedFiles(parseInt(parsed.query.limit, 10) || 200),
        });
      }
      if (req.method === 'GET' && pathName === '/api/history') {
        return sendJson(res, 200, {
          restartCount: state._state.restartCount,
          history: state.getRestartHistory(parseInt(parsed.query.limit, 10) || 50),
        });
      }
      if (req.method === 'GET' && pathName === '/api/logs') {
        return sendJson(res, 200, {
          logs: state.getLogs(
            parseInt(parsed.query.limit, 10) || 100,
            parsed.query.type
          ),
        });
      }
      if (req.method === 'GET' && pathName === '/api/tools') {
        return sendJson(res, 200, { tools: listToolsJson() });
      }
      if (req.method === 'GET' && pathName === '/api/config') {
        return sendJson(res, 200, state.getSnapshot().config || {});
      }

      if (req.method === 'POST' && pathName.indexOf('/api/tools/') === 0) {
        var toolName = decodeURIComponent(pathName.slice('/api/tools/'.length));
        var args;
        try {
          args = await readJsonBody(req);
        } catch (bodyErr) {
          if (bodyErr && bodyErr.code === 'PAYLOAD_TOO_LARGE') {
            return sendJson(res, 413, { error: bodyErr.message });
          }
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        try {
          var result = await invokeToolByName(toolName, args, nodemonApi);
          return sendJson(res, 200, result);
        } catch (e) {
          if (e && e.code === 'NOT_FOUND') {
            return sendJson(res, 404, { error: e.message, tools: listToolsJson() });
          }
          throw e;
        }
      }

      if (req.method === 'POST' && pathName === '/api/restart') {
        var r = await invokeToolByName('nodemon_restart', {}, nodemonApi);
        return sendJson(res, 200, r);
      }
      if (req.method === 'POST' && pathName === '/api/quit') {
        var q = await invokeToolByName('nodemon_quit', {}, nodemonApi);
        return sendJson(res, 200, q);
      }

      if (
        sseEnabled &&
        req.method === 'GET' &&
        (pathName === '/mcp' || pathName === '/sse')
      ) {
        var sseTransport = new mcpSdkSse.SSEServerTransport('/messages', res);
        var sessionId = sseTransport.sessionId;
        activeSseTransports[sessionId] = sseTransport;
        sseTransport.onclose = function () {
          delete activeSseTransports[sessionId];
        };
        var mcp = buildMcpServer(nodemonApi);
        await mcp.connect(sseTransport);
        return;
      }

      if (sseEnabled && req.method === 'POST' && pathName === '/messages') {
        var sid = parsed.query.sessionId;
        if (!sid || !activeSseTransports[sid]) {
          res.writeHead(400);
          return res.end('Missing or unknown sessionId');
        }
        var body;
        try {
          body = await readJsonBody(req);
        } catch (bodyErr2) {
          if (bodyErr2 && bodyErr2.code === 'PAYLOAD_TOO_LARGE') {
            return sendJson(res, 413, { error: bodyErr2.message });
          }
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        await activeSseTransports[sid].handlePostMessage(req, res, body);
        return;
      }

      sendJson(res, 404, {
        error: 'not found',
        try: [
          'GET /health',
          'GET /api/status',
          'GET /api/watched?limit=20',
          'GET /api/history',
          'GET /api/logs?limit=20',
          'GET /api/tools',
          'GET /api/config',
          'POST /api/tools/nodemon_status',
          'POST /api/tools/nodemon_restart',
          'POST /api/restart',
          'POST /api/quit',
          sseEnabled ? 'GET /mcp (MCP SSE)' : null,
        ].filter(Boolean),
      });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(err && err.message) });
      }
    }
  });

  activeHttpServer = httpServer;
  activeMode = 'http';

  return new Promise(function (resolve, reject) {
    httpServer.once('error', function (err) {
      activeHttpServer = null;
      activeMode = null;
      utils.log.error(
        'MCP HTTP server failed to bind ' +
          host +
          ':' +
          port +
          ' — ' +
          (err && err.message)
      );
      reject(err);
    });
    httpServer.listen(port, host, function () {
      var addr = 'http://' + host + ':' + port;
      var authNote = token ? ' (token auth on)' : ' (loopback, no token — local only)';
      utils.log.info(
        'MCP HTTP on ' +
          addr +
          authNote +
          ' — try GET /api/status or GET /api/tools (SSE ' +
          (sseEnabled ? 'on /mcp' : 'unavailable; optional SDK not loaded') +
          ')'
      );
      resolve({
        transport: 'http',
        port: port,
        host: host,
        url: addr,
        sse: sseEnabled,
        auth: !!token,
      });
    });
  });
}

module.exports = {
  start: start,
  stop: stop,
  buildMcpServer: buildMcpServer,
  invokeToolByName: invokeToolByName,
  listToolsJson: listToolsJson,
  isLoopbackHost: isLoopbackHost,
  authorizeRequest: authorizeRequest,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
};
