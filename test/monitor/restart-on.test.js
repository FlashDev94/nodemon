'use strict';
/*global describe, it */
var assert = require('assert');
var shouldRestartOnEvent = require('../../lib/monitor/watch').shouldRestartOnEvent;
var config = require('../../lib/config');

describe('shouldRestartOnEvent / restartOn', function () {
  var prev;

  function withRestartOn(value, fn) {
    prev = config.options;
    config.options = Object.assign({}, prev || {}, { restartOn: value });
    try {
      fn();
    } finally {
      config.options = prev;
    }
  }

  it('allows all events when unset, empty, or all (backward compatible)', function () {
    withRestartOn(undefined, function () {
      assert.equal(shouldRestartOnEvent('change'), true);
      assert.equal(shouldRestartOnEvent('add'), true);
      assert.equal(shouldRestartOnEvent('unlink'), true);
    });
    withRestartOn('all', function () {
      assert.equal(shouldRestartOnEvent('change'), true);
      assert.equal(shouldRestartOnEvent('add'), true);
      assert.equal(shouldRestartOnEvent('unlink'), true);
    });
    withRestartOn('', function () {
      assert.equal(shouldRestartOnEvent('change'), true);
    });
  });

  it('filters to change only', function () {
    withRestartOn('change', function () {
      assert.equal(shouldRestartOnEvent('change'), true);
      assert.equal(shouldRestartOnEvent('add'), false);
      assert.equal(shouldRestartOnEvent('unlink'), false);
    });
  });

  it('filters to add only', function () {
    withRestartOn('add', function () {
      assert.equal(shouldRestartOnEvent('add'), true);
      assert.equal(shouldRestartOnEvent('change'), false);
      assert.equal(shouldRestartOnEvent('unlink'), false);
    });
  });

  it('supports comma-separated and array lists', function () {
    withRestartOn('change,add', function () {
      assert.equal(shouldRestartOnEvent('change'), true);
      assert.equal(shouldRestartOnEvent('add'), true);
      assert.equal(shouldRestartOnEvent('unlink'), false);
    });
    withRestartOn(['change', 'unlink'], function () {
      assert.equal(shouldRestartOnEvent('change'), true);
      assert.equal(shouldRestartOnEvent('unlink'), true);
      assert.equal(shouldRestartOnEvent('add'), false);
    });
  });

  it('falls back to all events for invalid restartOn values', function () {
    var watch = require('../../lib/monitor/watch');
    if (typeof watch._resetRestartOnWarning === 'function') {
      watch._resetRestartOnWarning();
    }
    withRestartOn('modify', function () {
      assert.equal(shouldRestartOnEvent('change'), true);
      assert.equal(shouldRestartOnEvent('add'), true);
      assert.equal(shouldRestartOnEvent('unlink'), true);
    });
    withRestartOn(['change', 'nope'], function () {
      assert.equal(shouldRestartOnEvent('unlink'), true);
    });
  });

});
