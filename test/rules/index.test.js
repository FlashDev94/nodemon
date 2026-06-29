'use strict';
/*global describe:true, it: true, beforeEach: true */
var fs = require('fs'),
    path = require('path'),
    nodemon = require('../../lib/nodemon'),
    rules = require('../../lib/rules'),
    assert = require('assert');

var fixturesDir = path.resolve(__dirname, '..', 'fixtures');
var repoRoot = path.resolve(__dirname, '..', '..');

function loadfixtures(sample) {
  var filePath = path.join(fixturesDir, sample);
  return {
    content: fs.readFileSync(filePath, 'utf8'),
    path: filePath
  };
}

describe('nodemon rules', function () {
  var fixtures = {
    comments: loadfixtures('comments'),
    regexp: loadfixtures('regexp'),
    default: loadfixtures('default'),
    simple: loadfixtures('simple'),
    simplejson: loadfixtures('simple.json'),
  };

  beforeEach(function (done) {
    process.chdir(repoRoot);
    nodemon.reset(done);
  });

  it('should be resetable', function (done) {
    rules.load(fixtures.simplejson.path, function () {
      nodemon.reset();

      rules.load(fixtures.comments.path, function (error, loaded) {
        assert.deepEqual(
          loaded,
          { watch: [], ignore: [] },
          'rules are empty: ' + JSON.stringify(loaded)
        );
        done();
      });

    });
  });


  it('should read json', function (done) {
    rules.load(fixtures.simplejson.path, function (error, loaded) {
      assert(typeof loaded === 'object', 'rules file is parsed');
      done();
    });
  });

  it('should ignore comments files', function (done) {
    rules.load(fixtures.comments.path, function (error, loaded) {
      assert.equal(loaded.ignore.length, 0, 'zero ignore rules');
      done();
    });
  });

  it('should allow comments on lines', function (done) {
    rules.load(fixtures.simple.path, function (error, loaded) {
      loaded.ignore.forEach(function (rule) {
        assert.equal(rule.indexOf('# comment'), -1, 'no comment found');
      });
      done();
    });
  });

  it('should ignore regular expressions', function (done) {
    rules.load(fixtures.regexp.path, function (error, loaded) {
      assert.deepEqual(loaded, { 'watch': [], 'ignore': [] }, 'rules are empty');
      done();
    });
  });

  it('should callback with error when rules file is missing', function (done) {
    var missing = path.join(fixturesDir, 'missing-nodemon-rules-file');
    rules.load(missing, function (error) {
      assert(error, 'expected an error for missing file');
      done();
    });
  });
});
