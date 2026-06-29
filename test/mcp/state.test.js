'use strict';
/*global describe, it */
var assert = require('assert');
var bus = require('../../lib/utils/bus');
var state = require('../../lib/mcp/state');

describe('mcp state', function () {
  it('records start, watching, restart history, and logs when bound', function () {
    state.resetState();
    state.bindBus(bus, { options: { watch: ['*.js'] }, system: { cwd: process.cwd() } });

    bus.emit('start');
    bus.emit('watching', '/tmp/a.js');
    bus.emit('log', { type: 'detail', message: 'child pid: 4242' });
    bus.emit('restart', ['/tmp/a.js'], { type: 'watch', files: ['/tmp/a.js'] });

    var snap = state.getSnapshot();
    assert.equal(snap.status, 'restarting');
    assert.equal(snap.childPid, 4242);
    assert.equal(snap.restartCount, 1);
    assert.equal(snap.lastReason.type, 'watch');
    assert.deepEqual(state.getWatchedFiles(), ['/tmp/a.js']);
    assert.equal(state.getRestartHistory().length, 1);
    assert(state.getLogs().length >= 1);

    state.resetState();
  });

  it('does nothing invasive until bindBus (mcp off)', function () {
    state.resetState();
    assert.equal(state.getSnapshot().enabled, false);
  });
});
