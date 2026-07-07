'use strict';
/*global describe, it, afterEach */
var assert = require('assert');

var rr = require('../../lib/monitor/restart-reason');

describe('restart reason helpers', function () {
  it('formats watch / manual / api / signal reasons', function () {
    assert.equal(
      rr.formatRestartReason({ type: 'watch', files: ['a.js'] }),
      'file change (1 file)'
    );
    assert.equal(
      rr.formatRestartReason({ type: 'watch', files: ['a.js', 'b.js'] }),
      'file change (2 files)'
    );
    assert.equal(
      rr.formatRestartReason({ type: 'manual', trigger: 'rs' }),
      'manual (rs)'
    );
    assert.equal(rr.formatRestartReason({ type: 'api' }), 'api (nodemon.restart)');
    assert.equal(
      rr.formatRestartReason({ type: 'signal', signal: 'SIGHUP' }),
      'signal (SIGHUP)'
    );
    assert.equal(rr.formatRestartReason(null), 'unknown');
  });
});

describe('restart event reason (integration)', function () {
  var nodemon = require('../../lib/');
  var fs = require('fs');
  var path = require('path');
  var touch = require('touch');
  var crypto = require('crypto');
  var tmp = path.resolve(
    'test/fixtures/test-reason-' + crypto.randomBytes(8).toString('hex') + '.js'
  );

  afterEach(function () {
    if (fs.existsSync(tmp)) {
      fs.unlinkSync(tmp);
    }
  });

  it('passes reason.type=watch on file change without breaking files arg', function (done) {
    fs.writeFileSync(tmp, 'true;');
    var settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      nodemon.reset(function () {
        done(err);
      });
    }

    setTimeout(function () {
      nodemon({ script: tmp, ext: 'js', verbose: true })
        .once('start', function () {
          setTimeout(function () {
            touch.sync(tmp);
          }, 800);
        })
        .once('restart', function (files, reason) {
          try {
            assert(files && files.length > 0, 'files still provided');
            assert(reason, 'reason provided as 2nd arg');
            assert.equal(reason.type, 'watch');
            assert(reason.files && reason.files.length > 0);
          } catch (err) {
            nodemon.once('exit', function () {
              finish(err);
            }).emit('quit');
            return;
          }
          nodemon.once('exit', function () {
            finish();
          }).emit('quit');
        });
    }, 500);
  });

  it('passes reason.type=api for nodemon.restart()', function (done) {
    fs.writeFileSync(tmp, 'setTimeout(function(){}, 10000)');
    var settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      nodemon.reset(function () {
        done(err);
      });
    }

    setTimeout(function () {
      nodemon({ script: tmp, ext: 'js' })
        .once('start', function () {
          setTimeout(function () {
            nodemon.restart();
          }, 300);
        })
        .once('restart', function (files, reason) {
          try {
            assert.equal(reason && reason.type, 'api');
          } catch (err) {
            nodemon.once('exit', function () {
              finish(err);
            }).emit('quit');
            return;
          }
          nodemon.once('exit', function () {
            finish();
          }).emit('quit');
        });
    }, 500);
  });
});
