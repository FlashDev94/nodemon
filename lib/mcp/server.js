'use strict';

/**
 * Opt-in MCP server for nodemon.
 * When disabled (default), this module is never loaded from the hot path.
 *
 * Transports:
 * - http (default): SSE MCP on http://127.0.0.1:<port>/mcp  (+ POST /messages)
 * - stdio: standard MCP stdio (for clients that spawn nodemon as an MCP server)
 *
 * Also exposes simple REST helpers for manual testing:
 *   GET  /health
 *   GET  /api/status
 *   GET  /api/watched
 *   GET  /api/history
 *   GET  /api/logs
 *   POST /api/restart
 *   POST /api/quit
 */

var http = require('http');
var url = require('url');
var utils = require('../utils');
var config = require('../config');
var version = require('../version');
var state = require('./state');

var mcpSdkServer;
var mcpSdkSse;
var mcpSdkStdio;
var z;

try {
  mcpSdkServer = require('@modelcontextprotocol/sdk/server/mcp.js');
  mcpSdkSse = require('@modelcontextprotocol/sdk/server/sse.js');
  mcpSdkStdio = require('@modelcontextprotocol/sdk/server/stdio.js');
  z = require('zod');
} catch (e) {
  mcpSdkServer = null;
}

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

function buildMcpServer(nodemonApi) {
  var McpServer = mcpSdkServer.McpServer;
  var server = new McpServer(
    {
      name: 'nodemon',
      version: version.pinned || '0.0.0',
    },
    { capabilities: { tools: {} } }
  );

  server.tool(
    'nodemon_status',
    'Get nodemon runtime status (running/crashed/etc), pids, restart count, config summary',
    async function () {
      return textResult(state.getSnapshot());
    }
  );

  server.tool(
    'nodemon_watched_files',
    'List files currently tracked by the watcher (most recent first, limited)',
    {
      limit: z.number().int().positive().max(5000).optional().describe('Max files to return (default 200)'),
    },
    async function (args) {
      return textResult({
        count: state._state.watchedFiles.length,
        files: state.getWatchedFiles(args && args.limit),
      });
    }
  );

  server.tool(
    'nodemon_restart_history',
    'Recent restart history with reasons and files when available',
    {
      limit: z.number().int().positive().max(200).optional().describe('Max entries (default 50)'),
    },
    async function (args) {
      return textResult({
        restartCount: state._state.restartCount,
        history: state.getRestartHistory(args && args.limit),
      });
    }
  );

  server.tool(
    'nodemon_logs',
    'Recent nodemon log lines (status/detail/error/etc)',
    {
      limit: z.number().int().positive().max(500).optional().describe('Max lines (default 100)'),
      type: z
        .string()
        .optional()
        .describe('Optional log type filter: detail, status, error, fail, log'),
    },
    async function (args) {
      return textResult({
        logs: state.getLogs(args && args.limit, args && args.type),
      });
    }
  );

  server.tool(
    'nodemon_config',
    'Return a summary of the active nodemon configuration',
    async function () {
      return textResult(state.getSnapshot().config || {});
    }
  );

  server.tool(
    'nodemon_restart',
    'Trigger a nodemon restart of the child process (same as typing rs / API restart)',
    async function () {
      if (nodemonApi && typeof nodemonApi.restart === 'function') {
        nodemonApi.restart();
      } else {
        utils.bus.emit('restart');
      }
      return textResult({ ok: true, action: 'restart', at: new Date().toISOString() });
    }
  );

  server.tool(
    'nodemon_quit',
    'Ask nodemon to quit (stops watching and exits the monitor)',
    async function () {
      utils.bus.emit('quit');
      return textResult({ ok: true, action: 'quit', at: new Date().toISOString() });
    }
  );

  return server;
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

/**
 * Start MCP (and REST helper) server.
 * @param {object} options
 * @param {object} nodemonApi nodemon export (for .restart())
 * @returns {Promise<{port?:number, transport:string}>}
 */
function start(options, nodemonApi) {
  state.bindBus(utils.bus, config);

  var transport = (options.mcpTransport || options.mcp || 'http').toString().toLowerCase();
  if (transport === 'true' || transport === '1') {
    transport = 'http';
  }

  if (!mcpSdkServer) {
    utils.log.error('MCP SDK not installed; run npm install @modelcontextprotocol/sdk');
    return Promise.resolve({ transport: 'none' });
  }

  if (transport === 'stdio') {
    var stdioServer = buildMcpServer(nodemonApi);
    var stdioTransport = new mcpSdkStdio.StdioServerTransport();
    return stdioServer.connect(stdioTransport).then(function () {
      // avoid corrupting MCP stdio with normal logs on stdout
      utils.log.info('MCP stdio server connected');
      return { transport: 'stdio' };
    });
  }

  var port = parseInt(options.mcpPort, 10);
  if (!port || port < 1) {
    port = 8765;
  }
  var host = options.mcpHost || '127.0.0.1';

  var transports = {};

  var httpServer = http.createServer(async function (req, res) {
    var parsed = url.parse(req.url, true);
    var pathName = parsed.pathname || '/';

    // CORS for local agent tools
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (req.method === 'GET' && pathName === '/health') {
        return sendJson(res, 200, { ok: true, mcp: true });
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
          logs: state.getLogs(parseInt(parsed.query.limit, 10) || 100, parsed.query.type),
        });
      }
      if (req.method === 'POST' && pathName === '/api/restart') {
        if (nodemonApi && nodemonApi.restart) {
          nodemonApi.restart();
        } else {
          utils.bus.emit('restart');
        }
        return sendJson(res, 200, { ok: true, action: 'restart' });
      }
      if (req.method === 'POST' && pathName === '/api/quit') {
        utils.bus.emit('quit');
        return sendJson(res, 200, { ok: true, action: 'quit' });
      }

      // MCP SSE (protocol 2024-11-05 style)
      if (req.method === 'GET' && (pathName === '/mcp' || pathName === '/sse')) {
        var sseTransport = new mcpSdkSse.SSEServerTransport('/messages', res);
        var sessionId = sseTransport.sessionId;
        transports[sessionId] = sseTransport;
        sseTransport.onclose = function () {
          delete transports[sessionId];
        };
        var mcp = buildMcpServer(nodemonApi);
        await mcp.connect(sseTransport);
        utils.log.detail('MCP SSE client connected session=' + sessionId);
        return;
      }

      if (req.method === 'POST' && pathName === '/messages') {
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
        hint: 'Use GET /mcp for MCP SSE, or /api/status|/api/watched|/api/history|/api/logs, POST /api/restart|/api/quit',
      });
    } catch (err) {
      utils.log.error('MCP HTTP error: ' + (err && err.message));
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(err && err.message) });
      }
    }
  });

  return new Promise(function (resolve, reject) {
    httpServer.once('error', reject);
    httpServer.listen(port, host, function () {
      var addr = 'http://' + host + ':' + port;
      utils.log.info('MCP server listening on ' + addr + ' (SSE /mcp, REST /api/*)');
      resolve({ transport: 'http', port: port, host: host, url: addr });
    });
  });
}

module.exports = {
  start: start,
  buildMcpServer: buildMcpServer,
};
