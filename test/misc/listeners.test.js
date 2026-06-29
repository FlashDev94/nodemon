/*global describe, it, beforeEach */

var nodemon = require('../../lib/');
var assert = require('assert');
var path = require('path');
var dir = path.resolve(__dirname, '..', 'fixtures', 'events');
var appjs = path.resolve(dir, 'env.js');
var async = require('async');

describe('listeners clean up', function () {
  function conf() {
    return {
      script: appjs,
      verbose: true,
      stdout: false,
      noReset: true,
      ext: 'js',
      env: {
        PORT: 0,
        NODEMON_ENV: 'nodemon',
      },
    };
  }

  beforeEach(function (done) {
    nodemon.reset(done);
  });

  it(
    'should be able to re-run in required mode, many times, and not leak' +
      'listeners',
    function (done) {
      function run(n) {
        return function (next) {
          var settled = false;
          function finish(err) {
            if (settled) {
              return;
            }
            settled = true;
            next(err);
          }

          // script exits on its own; use once so async.series is not called twice
          nodemon(conf());
          nodemon.once('start', function () {
            nodemon.once('exit', function () {
              nodemon.reset(finish);
            });
          });
        };
      }

      var toRun = '01234567890123456789'.split('').map(run);
      toRun.push(function () {
        done();
      });

      async.series(toRun);
    }
  );
});

