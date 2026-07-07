'use strict';
/*global describe, it */
var assert = require('assert');
var add = require('../../lib/rules/add');

describe('rules/add', function () {
  it('throws when which is not ignore or watch', function () {
    assert.throws(function () {
      add({ ignore: [], watch: [] }, 'nope', '*.js');
    }, /requires "ignore" or "watch"/);
  });

  it('supports array of rules', function () {
    var rules = { ignore: [], watch: [] };
    add(rules, 'ignore', ['a.js', 'b.js']);
    assert.equal(rules.ignore.length, 2);
    assert(rules.ignore.re instanceof RegExp);
  });

  it('ignores blank and comment-only rules', function () {
    var rules = { ignore: [], watch: [] };
    add(rules, 'ignore', '');
    add(rules, 'ignore', '   ');
    add(rules, 'ignore', '# just a comment');
    assert.equal(rules.ignore.length, 0);
  });

  it('does not support RegExp instances (logs and skips)', function () {
    var rules = { ignore: [], watch: [] };
    add(rules, 'watch', /\.js$/);
    assert.equal(rules.watch.length, 0);
  });

  it('strips inline comments but keeps escaped hash', function () {
    var rules = { ignore: [], watch: [] };
    add(rules, 'ignore', 'foo.js # comment');
    assert.equal(rules.ignore[0], 'foo.js');
  });
});
