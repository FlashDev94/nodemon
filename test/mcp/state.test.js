'use strict';
/*global describe, it */
var assert = require('assert');
var bus = require('../../lib/utils/bus');
var state = require('../../lib/mcp/state');

describe('mcp state', function () {
  afterEach(function () {
    state.resetState();
  });

  it('tracks start pid, crash, restart history, and unwatch', function () {
    state.resetState();
    state.bindBus(bus, {
      options: {
        mcp: true,
        mcpPort: 9,
        watch: ['*.js'],
        restartOn: 'change',
      },
      system: { cwd: '/tmp' },
      command: { string: 'node app.js' },
    });

    bus.emit('start', 42);
    assert.equal(state._state.status, 'running');
    assert.equal(state._state.childPid, 42);

    bus.emit('watching', '/tmp/a.js');
    bus.emit('watching', '/tmp/b.js');
    assert.equal(state.getWatchedFiles().length, 2);

    bus.emit('unwatch', '/tmp/a.js');
    assert.deepEqual(state.getWatchedFiles(), ['/tmp/b.js']);

    bus.emit('restart', ['/tmp/b.js'], { type: 'watch', files: ['/tmp/b.js'] });
    assert.equal(state._state.restartCount, 1);
    assert.equal(state._state.lastReason.type, 'watch');

    bus.emit('crash', 1);
    assert.equal(state._state.status, 'crashed');
    assert.equal(state.getLastCrash().exitCode, 1);
    assert.equal(state.getSnapshot().lastCrash.exitCode, 1);

    state.resetState();
    assert.equal(state._state.bound, false);
    assert.equal(state.getWatchedFiles().length, 0);
  });

  it('re-binds cleanly after resetState', function () {
    state.bindBus(bus, { options: { mcp: true }, system: { cwd: '/' } });
    bus.emit('start', 1);
    state.resetState();
    state.bindBus(bus, { options: { mcp: true }, system: { cwd: '/' } });
    bus.emit('start', 2);
    assert.equal(state._state.childPid, 2);
  });
});
