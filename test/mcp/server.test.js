'use strict';
/*global describe, it */
var assert = require('assert');
var bus = require('../../lib/utils/bus');
var state = require('../../lib/mcp/state');
var mcpServer = require('../../lib/mcp/server');

describe('mcp server tools', function () {
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
        state.resetState();
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
});
