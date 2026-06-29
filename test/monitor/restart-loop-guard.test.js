'use strict';
/*global describe, it */
var assert = require('assert');
var normalize = require('../../lib/monitor/watch').normalizeRestartLoopGuard;

describe('normalizeRestartLoopGuard (no breaking changes when off)', function () {
  it('returns null when unset / falsy so restart path is unchanged', function () {
    assert.strictEqual(normalize(undefined), null);
    assert.strictEqual(normalize(null), null);
    assert.strictEqual(normalize(false), null);
    assert.strictEqual(normalize(0), null);
    assert.strictEqual(normalize(''), null);
  });

  it('returns null for unsupported values (ignored = normal restarts)', function () {
    assert.strictEqual(normalize('yes'), null);
    assert.strictEqual(normalize({}), null);
    assert.strictEqual(normalize({ max: 0 }), null);
    assert.strictEqual(normalize({ max: -1 }), null);
    assert.strictEqual(normalize([]), null);
  });

  it('enables defaults when true', function () {
    var g = normalize(true);
    assert.strictEqual(g.max, 10);
    assert.strictEqual(g.window, 10000);
  });

  it('treats a positive number as max with default window', function () {
    var g = normalize(5);
    assert.strictEqual(g.max, 5);
    assert.strictEqual(g.window, 10000);
  });

  it('accepts { max, window } and defaults window when missing/invalid', function () {
    assert.deepEqual(normalize({ max: 3, window: 2000 }), {
      max: 3,
      window: 2000,
    });
    assert.deepEqual(normalize({ max: 4 }), { max: 4, window: 10000 });
    assert.deepEqual(normalize({ max: 4, window: 0 }), {
      max: 4,
      window: 10000,
    });
  });
});
