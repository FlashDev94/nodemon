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
 * stdio mode (--mcp-stdio):
 *   Full MCP over stdin/stdout. Prefer HTTP if you still want terminal logs.
 */

var http = require('http');
var url = require('url');
var utils = require('../utils');
var config = require('../config');
var version = require('../version');
var state = require('./state');

var mcpSdkServer = null;
var mcpSdkSse = null;
var mcpSdkStdio = null;
var z = null;

try {
  mcpSdkServer = require('@modelcontextprotocol/sdk/server/mcp.js');
  mcpSdkSse = require('@modelcontextprotocol/sdk/server/sse.js');
  mcpSdkStdio = require('@modelcontextprotocol/sdk/server/stdio.js');
  z = require('zod');
} catch (e) {
  // leave null — start() reports a clear error
}

/** @type {null|{name:string,description:string,handler:Function}[]} */
var toolDefs = null;

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
        'Get nodemon runtime status (running/crashed/etc), pids, restart count, config summary',
      handler: async function () {
        return textResult(state.getSnapshot());
      },
    },
    {
      name: 'nodemon_watched_files',
      description: 'List files currently tracked by the watcher (limited)',
      inputSchema: z
        ? { limit: z.number().int().positive().max(5000).optional() }
        : undefined,
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
      inputSchema: z
        ? { limit: z.number().int().positive().max(200).optional() }
        : undefined,
      handler: async function (args) {
        return textResult({
          restartCount: state._state.restartCount,
          history: state.getRestartHistory(args && args.limit),
        });
      },
    },
    {
      name: 'nodemon_logs',
      description: 'Recent nodemon log lines (status/detail/error/etc)',
      inputSchema: z
        ? {
            limit: z.number().int().positive().max(500).optional(),
            type: z.string().optional(),
          }
        : undefined,
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
        'Trigger a nodemon restart of the child process (same as typing rs / API restart)',
      handler: async function () {
        if (nodemonApi && typeof nodemonApi.restart === 'function') {
          nodemonApi.restart();
        } else {
          utils.bus.emit('restart');
        }
        return textResult({
          ok: true,
          action: 'restart',
          at: new Date().toISOString(),
        });
      },
    },
    {
      name: 'nodemon_quit',
      description: 'Ask nodemon to quit (stops watching and exits the monitor)',
      handler: async function () {
        // delay so HTTP/MCP can flush the response
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
    if (def.inputSchema) {
      server.tool(def.name, def.description, def.inputSchema, def.handler);
    } else {
      server.tool(def.name, def.description, def.handler);
    }
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
    req.on('data', function (c) {
      chunks.push(c);
    });
    req.on('end', function () {
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
    // never write to stdout in stdio MCP mode
    try {
      process.stderr.write('[nodemon] ' + message + '\n');
    } catch (e) { /* ignore */ }
  } else {
    utils.log.info(message);
  }
}

/**
 * @param {object} options nodemon options
 * @param {object} nodemonApi
 * @returns {Promise<object>}
 */
function start(options, nodemonApi) {
  state.bindBus(utils.bus, config);
  // ensure tool defs exist for REST even before SSE connect
  toolDefs = defineTools(nodemonApi);

  var transport = (options.mcpTransport || 'http').toString().toLowerCase();
  if (transport === 'true' || transport === '1') {
    transport = 'http';
  }

  if (transport === 'stdio') {
    if (!mcpSdkServer || !mcpSdkStdio) {
      mcpLog(
        'MCP SDK missing; npm install @modelcontextprotocol/sdk',
        true
      );
      return Promise.resolve({ transport: 'none' });
    }
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
  var transports = {};
  var sseEnabled = !!(mcpSdkServer && mcpSdkSse);

  var httpServer = http.createServer(async function (req, res) {
    var parsed = url.parse(req.url, true);
    var pathName = parsed.pathname || '/';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (req.method === 'GET' && pathName === '/health') {
        return sendJson(res, 200, {
          ok: true,
          mcp: true,
          sse: sseEnabled,
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

      // Invoke the same handlers MCP tools use (no SSE client required)
      if (req.method === 'POST' && pathName.indexOf('/api/tools/') === 0) {
        var toolName = decodeURIComponent(pathName.slice('/api/tools/'.length));
        var args = await readJsonBody(req);
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

      // MCP SSE — only if SDK loaded
      if (
        sseEnabled &&
        req.method === 'GET' &&
        (pathName === '/mcp' || pathName === '/sse')
      ) {
        var sseTransport = new mcpSdkSse.SSEServerTransport('/messages', res);
        var sessionId = sseTransport.sessionId;
        transports[sessionId] = sseTransport;
        sseTransport.onclose = function () {
          delete transports[sessionId];
        };
        var mcp = buildMcpServer(nodemonApi);
        await mcp.connect(sseTransport);
        return;
      }

      if (sseEnabled && req.method === 'POST' && pathName === '/messages') {
        var sid = parsed.query.sessionId;
        if (!sid || !transports[sid]) {
          res.writeHead(400);
          return res.end('Missing or unknown sessionId');
        }
        var body = await readJsonBody(req);
        await transports[sid].handlePostMessage(req, res, body);
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

  return new Promise(function (resolve, reject) {
    httpServer.once('error', function (err) {
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
      utils.log.info(
        'MCP HTTP on ' +
          addr +
          ' — try GET /api/status or GET /api/tools (SSE ' +
          (sseEnabled ? 'on /mcp' : 'unavailable') +
          ')'
      );
      resolve({
        transport: 'http',
        port: port,
        host: host,
        url: addr,
        sse: sseEnabled,
      });
    });
  });
}

module.exports = {
  start: start,
  buildMcpServer: buildMcpServer,
  invokeToolByName: invokeToolByName,
  listToolsJson: listToolsJson,
};
