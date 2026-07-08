'use strict';
/*global describe, it, beforeEach, afterEach */
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var cli = require('../../lib/cli');
var nodemon = require('../../lib/');

describe('CLI --kill-timeout', function () {
  it('parses bare numbers as milliseconds', function () {
    var s = cli.parse('node nodemon --kill-timeout 3000 app.js');
    assert.equal(s.killTimeout, 3000);
  });

  it('parses ms and s suffixes', function () {
    assert.equal(
      cli.parse('node nodemon --kill-timeout 500ms app.js').killTimeout,
      500
    );
    assert.equal(
      cli.parse('node nodemon --kill-timeout 2s app.js').killTimeout,
      2000
    );
  });

  it('parses --killTimeout camelCase alias', function () {
    assert.equal(
      cli.parse('node nodemon --killTimeout 100 app.js').killTimeout,
      100
    );
  });

  it('defaults to undefined/absent when flag not passed', function () {
    var s = cli.parse('node nodemon app.js');
    assert.ok(
      s.killTimeout === undefined || s.killTimeout === 0,
      'no killTimeout without flag'
    );
  });
});

describe('killTimeout force kill (integration)', function () {
  var tmp;

  beforeEach(function (done) {
    tmp = path.resolve(
      'test/fixtures/test-kill-timeout-' +
        crypto.randomBytes(8).toString('hex') +
        '.js'
    );
    nodemon.reset(done);
  });

  afterEach(function (done) {
    // quit uses SIGINT (not config.signal), so processes that only ignore
    // SIGUSR2 for the hang tests still exit cleanly and do not leak.
    var finished = false;
    function finish() {
      if (finished) {
        return;
      }
      finished = true;
      if (tmp && fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch (e) {}
      }
      nodemon.reset(done);
    }
    try {
      nodemon.emit('quit');
    } catch (e) {}
    setTimeout(finish, 400);
  });

  it('force-kills a process that ignores the graceful signal', function (done) {
    this.timeout(15000);

    // Ignore SIGUSR2 (nodemon default) so graceful kill would hang without timeout
    fs.writeFileSync(
      tmp,
      [
        "process.on('SIGUSR2', function () { /* ignore */ });",
        "process.on('SIGTERM', function () { /* ignore */ });",
        'setInterval(function () {}, 60000);',
        "console.log('HANGING');",
      ].join('\n')
    );

    var starts = 0;
    var sawForceLog = false;
    var settled = false;

    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      done(err);
    }

    nodemon({
      script: tmp,
      ext: 'js',
      stdout: false,
      restartable: false,
      killTimeout: 400,
      signal: 'SIGUSR2',
    })
      .on('log', function (ev) {
        if (ev && ev.message && /killTimeout|SIGKILL/i.test(ev.message)) {
          sawForceLog = true;
        }
      })
      .on('start', function () {
        starts += 1;
        if (starts === 1) {
          setTimeout(function () {
            nodemon.restart();
          }, 300);
        } else if (starts === 2) {
          try {
            assert.ok(sawForceLog, 'should log force kill after killTimeout');
            finish();
          } catch (e) {
            finish(e);
          }
        }
      })
      .on('crash', function () {
        // SIGKILL may surface oddly; second start is the success signal
      });
  });

  it('does not force-kill when process exits before timeout', function (done) {
    this.timeout(12000);

    fs.writeFileSync(
      tmp,
      [
        // exit promptly on SIGUSR2 (default nodemon signal handling for many apps
        // is to die; we exit explicitly)
        "process.on('SIGUSR2', function () { process.exit(0); });",
        'setInterval(function () {}, 60000);',
      ].join('\n')
    );

    var starts = 0;
    var sawForceLog = false;
    var settled = false;

    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      done(err);
    }

    nodemon({
      script: tmp,
      ext: 'js',
      stdout: false,
      restartable: false,
      killTimeout: 2000,
      signal: 'SIGUSR2',
    })
      .on('log', function (ev) {
        if (ev && ev.message && /killTimeout|sending SIGKILL/i.test(ev.message)) {
          sawForceLog = true;
        }
      })
      .on('start', function () {
        starts += 1;
        if (starts === 1) {
          setTimeout(function () {
            nodemon.restart();
          }, 300);
        } else if (starts === 2) {
          try {
            assert.strictEqual(
              sawForceLog,
              false,
              'must not force-kill when process exits in time'
            );
            finish();
          } catch (e) {
            finish(e);
          }
        }
      });
  });

  it('without killTimeout, ignores hanging process until we quit (no force log)', function (done) {
    this.timeout(8000);

    fs.writeFileSync(
      tmp,
      [
        "process.on('SIGUSR2', function () { /* ignore */ });",
        'setInterval(function () {}, 60000);',
      ].join('\n')
    );

    var sawForceLog = false;
    var settled = false;

    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      done(err);
    }

    nodemon({
      script: tmp,
      ext: 'js',
      stdout: false,
      restartable: false,
      // killTimeout intentionally omitted
    })
      .on('log', function (ev) {
        if (ev && ev.message && /sending SIGKILL/i.test(ev.message)) {
          sawForceLog = true;
        }
      })
      .once('start', function () {
        nodemon.restart();
        // give it time — without killTimeout it should NOT force-kill
        setTimeout(function () {
          try {
            assert.strictEqual(sawForceLog, false, 'no force kill without flag');
            finish();
          } catch (e) {
            finish(e);
          }
        }, 800);
      });
  });
});
