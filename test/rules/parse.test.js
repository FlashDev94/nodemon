'use strict';
/*global describe, it */
var assert = require('assert');
var path = require('path');
var parse = require('../../lib/rules/parse');

// Absolute paths — other suites may have changed process.cwd()
var fixtures = path.resolve(__dirname, '..', 'fixtures');

describe('rules/parse', function () {
  it('parses JSON ignore/watch rules', function (done) {
    parse(path.join(fixtures, 'simple.json'), function (err, rules) {
      assert.ifError(err);
      assert(Array.isArray(rules.ignore));
      assert(Array.isArray(rules.watch));
      done();
    });
  });

  it('returns raw lines for non-JSON text files', function (done) {
    parse(path.join(fixtures, 'simple'), function (err, rules) {
      assert.ifError(err);
      assert(Array.isArray(rules.raw));
      assert(rules.raw.length > 0);
      done();
    });
  });

  it('callbacks with error when file is missing', function (done) {
    parse(path.join(fixtures, 'does-not-exist-nodemon-rules'), function (err) {
      assert(err, 'expected error for missing file');
      done();
    });
  });
});

