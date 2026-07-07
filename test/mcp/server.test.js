'use strict';
/*global describe, it */
var assert = require('assert');
var http = require('http');
var bus = require('../../lib/utils/bus');
var state = require('../../lib/mcp/state');
var mcpServer = require('../../lib/mcp/server');

function httpJson(method, port, path, headers, body) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request(
      {
        hostname: '127.0.0.1',
        port: port,
        path: path,
        method: method,
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': data ? Buffer.byteLength(data) : 0,
          },
          headers || {}
        ),
      },
      function (res) {
        var chunks = [];
        res.on('data', function (c) {
          chunks.push(c);
        });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8');
          var json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            json = text;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, text: text });
        });
      }
    );
    req.on('error', reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

describe('mcp server tools', function () {
  afterEach(function (done) {
    mcpServer.stop(function () {
      state.resetState();
      done();
    });
  });

  it('lists expected tool names', function () {
    var names = mcpServer.listToolsJson().map(function (t) {
      return t.name;
    });
    [
      'nodemon_status',
      'nodemon_watched_files',
      'nodemon_restart_history',
      'nodemon_last_crash',
      'nodemon_logs',
      'nodemon_config',
      'nodemon_restart',
      'nodemon_quit',
    ].forEach(function (n) {
      assert(names.indexOf(n) !== -1, 'missing tool ' + n);
    });
  });

  it('invokes nodemon_status and nodemon_last_crash handlers', function () {
    state.resetState();
    state.bindBus(bus, {
      options: { mcp: true, mcpPort: 1, watch: ['*.js'] },
      system: { cwd: process.cwd() },
      command: { string: 'node app.js' },
    });
    bus.emit('start', 55);
    bus.emit('crash', 7);

    return mcpServer
      .invokeToolByName('nodemon_status', {}, null)
      .then(function (result) {
        var text = result.content[0].text;
        var snap = JSON.parse(text);
        assert.equal(snap.status, 'crashed');
        assert.equal(snap.lastCrash.exitCode, 7);
        return mcpServer.invokeToolByName('nodemon_last_crash', {}, null);
      })
      .then(function (result) {
        var body = JSON.parse(result.content[0].text);
        assert.equal(body.lastCrash.exitCode, 7);
        assert.equal(body.status, 'crashed');
      });
  });

  it('rejects unknown tools', function () {
    return mcpServer.invokeToolByName('not_a_real_tool', {}, null).then(
      function () {
        assert.fail('expected error');
      },
      function (err) {
        assert.equal(err.code, 'NOT_FOUND');
      }
    );
  });

  it('records trigger mcp on nodemon_restart tool', function () {
    state.resetState();
    state.bindBus(bus, {
      options: { mcp: true },
      system: { cwd: process.cwd() },
    });
    return mcpServer.invokeToolByName('nodemon_restart', {}, null).then(function () {
      assert.equal(state._state.lastReason.type, 'api');
      assert.equal(state._state.lastReason.trigger, 'mcp');
    });
  });

  it('serves REST health/status and stops cleanly', function () {
    this.timeout(10000);
    var port = 18765 + Math.floor(Math.random() * 1000);
    return mcpServer
      .start(
        {
          mcp: true,
          mcpTransport: 'http',
          mcpPort: port,
          mcpHost: '127.0.0.1',
        },
        null
      )
      .then(function (info) {
        assert.equal(info.transport, 'http');
        return httpJson('GET', port, '/health');
      })
      .then(function (res) {
        assert.equal(res.status, 200);
        assert.equal(res.body.ok, true);
        // no open CORS
        assert.equal(res.headers['access-control-allow-origin'], undefined);
        return httpJson('GET', port, '/api/status');
      })
      .then(function (res) {
        assert.equal(res.status, 200);
        assert(res.body.status);
        return new Promise(function (resolve) {
          mcpServer.stop(resolve);
        });
      })
      .then(function () {
        // port should be free — rebinding same port must succeed
        return mcpServer.start(
          {
            mcp: true,
            mcpTransport: 'http',
            mcpPort: port,
            mcpHost: '127.0.0.1',
          },
          null
        );
      })
      .then(function (info) {
        assert.equal(info.transport, 'http');
      });
  });

  it('enforces mcpToken on non-health routes', function () {
    this.timeout(10000);
    var port = 19765 + Math.floor(Math.random() * 1000);
    return mcpServer
      .start(
        {
          mcp: true,
          mcpTransport: 'http',
          mcpPort: port,
          mcpHost: '127.0.0.1',
          mcpToken: 's3cret',
        },
        null
      )
      .then(function () {
        return httpJson('GET', port, '/health');
      })
      .then(function (res) {
        assert.equal(res.status, 200);
        return httpJson('GET', port, '/api/status');
      })
      .then(function (res) {
        assert.equal(res.status, 401);
        return httpJson('GET', port, '/api/status', {
          Authorization: 'Bearer s3cret',
        });
      })
      .then(function (res) {
        assert.equal(res.status, 200);
        return httpJson('GET', port, '/api/status', {
          'X-Nodemon-Mcp-Token': 's3cret',
        });
      })
      .then(function (res) {
        assert.equal(res.status, 200);
      });
  });

  it('refuses non-loopback bind without allow+token', function () {
    return mcpServer
      .start(
        {
          mcp: true,
          mcpTransport: 'http',
          mcpPort: 8765,
          mcpHost: '0.0.0.0',
        },
        null
      )
      .then(
        function () {
          assert.fail('expected reject');
        },
        function (err) {
          assert(err && /non-loopback|refused/i.test(String(err.message)));
        }
      );
  });

  it('isLoopbackHost and authorizeRequest helpers', function () {
    assert.equal(mcpServer.isLoopbackHost('127.0.0.1'), true);
    assert.equal(mcpServer.isLoopbackHost('0.0.0.0'), false);
    assert.equal(mcpServer.isLoopbackHost('localhost'), true);

    var opts = { mcpToken: 'tok' };
    var ok = mcpServer.authorizeRequest(
      { method: 'GET', headers: { authorization: 'Bearer tok' } },
      { query: {} },
      opts,
      '/api/status'
    );
    assert.equal(ok, true);
    var bad = mcpServer.authorizeRequest(
      { method: 'GET', headers: {} },
      { query: {} },
      opts,
      '/api/status'
    );
    assert.equal(bad, false);
    var health = mcpServer.authorizeRequest(
      { method: 'GET', headers: {} },
      { query: {} },
      opts,
      '/health'
    );
    assert.equal(health, true);
  });
});
