'use strict';
/*global describe, it, beforeEach, afterEach */
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var rc = require('../../lib/monitor/restart-cmd');
var rr = require('../../lib/monitor/restart-reason');

describe('restart-cmd parseRestartLine', function () {
  it('returns null for non-restart input (stdin must still forward)', function () {
    assert.strictEqual(rc.parseRestartLine('hello', 'rs'), null);
    assert.strictEqual(rc.parseRestartLine('rshello', 'rs'), null);
    assert.strictEqual(rc.parseRestartLine('', 'rs'), null);
    assert.strictEqual(rc.parseRestartLine('  ', 'rs'), null);
    assert.strictEqual(rc.parseRestartLine('rs', false), null);
    assert.strictEqual(rc.parseRestartLine('rs', ''), null);
  });

  it('parses plain rs with historical case rules on input only', function () {
    assert.deepEqual(rc.parseRestartLine('rs', 'rs'), { extraArgs: [] });
    assert.deepEqual(rc.parseRestartLine('RS', 'rs'), { extraArgs: [] });
    assert.deepEqual(rc.parseRestartLine('  rs  \n', 'rs'), { extraArgs: [] });
    assert.strictEqual(rc.parseRestartLine('rs', 'RS'), null);
    assert.strictEqual(rc.parseRestartLine('RS', 'RS'), null);
  });

  it('parses rs <args> preserving arg case and quotes', function () {
    assert.deepEqual(rc.parseRestartLine('rs --debug', 'rs'), {
      extraArgs: ['--debug'],
    });
    assert.deepEqual(rc.parseRestartLine('rs --port 4000', 'rs'), {
      extraArgs: ['--port', '4000'],
    });
    assert.deepEqual(rc.parseRestartLine('RS --Name MyApp', 'rs'), {
      extraArgs: ['--Name', 'MyApp'],
    });
    assert.deepEqual(rc.parseRestartLine('rs --name "my app"', 'rs'), {
      extraArgs: ['--name', 'my app'],
    });
    assert.deepEqual(rc.parseRestartLine("rs --name 'my app'", 'rs'), {
      extraArgs: ['--name', 'my app'],
    });
  });

  it('supports custom restartable command', function () {
    assert.deepEqual(rc.parseRestartLine('restart --foo', 'restart'), {
      extraArgs: ['--foo'],
    });
    assert.strictEqual(rc.parseRestartLine('rs --foo', 'restart'), null);
  });

  it('tokenizeArgs groups quoted values and collapses whitespace', function () {
    assert.deepEqual(rc.tokenizeArgs('a  b'), ['a', 'b']);
    assert.deepEqual(rc.tokenizeArgs('"a b" c'), ['a b', 'c']);
    assert.deepEqual(rc.tokenizeArgs(''), []);
  });
});


describe('restart-cmd shell-unsafe one-shot args', function () {
  it('detects shell metacharacters and operators', function () {
    assert.strictEqual(rc.isUnsafeOneShotArg('&&'), true);
    assert.strictEqual(rc.isUnsafeOneShotArg('||'), true);
    assert.strictEqual(rc.isUnsafeOneShotArg(';'), true);
    assert.strictEqual(rc.isUnsafeOneShotArg('$(id)'), true);
    assert.strictEqual(rc.isUnsafeOneShotArg('`id`'), true);
    assert.strictEqual(rc.isUnsafeOneShotArg('a;b'), true);
    assert.strictEqual(rc.isUnsafeOneShotArg('--port'), false);
    assert.strictEqual(rc.isUnsafeOneShotArg('4000'), false);
    assert.strictEqual(rc.isUnsafeOneShotArg('my app'), false);
  });

  it('validateOneShotArgs rejects unsafe lists', function () {
    assert.deepEqual(rc.validateOneShotArgs(['--ok', '1']), { ok: true });
    var bad = rc.validateOneShotArgs(['&&', 'echo', 'x']);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.unsafe.indexOf('&&') !== -1);
  });

  it('requestRestart refuses unsafe args and does not emit restart', function () {
    var bus = require('../../lib/utils').bus;
    var fired = false;
    function onRestart() {
      fired = true;
    }
    bus.on('restart', onRestart);
    var ok = rc.requestRestart(undefined, {
      type: 'manual',
      trigger: 'rs',
      args: ['&&', 'id'],
    });
    bus.removeListener('restart', onRestart);
    assert.strictEqual(ok, false);
    assert.strictEqual(fired, false);
  });
});

describe('restart-cmd requestRestart ownership', function () {
  it('plain manual/api requestRestart clears pending one-shot', function () {
    var config = require('../../lib/config');
    config.commandBase = { executable: 'node', args: ['app.js'] };
    config.oneShotArgs = ['--stale'];
    config.command = {
      raw: config.commandBase,
      string: 'node app.js',
    };

    var bus = require('../../lib/utils').bus;
    function onRestart() {}
    bus.on('restart', onRestart);

    rc.requestRestart(undefined, { type: 'api' });
    assert.strictEqual(config.oneShotArgs, null, 'api clears pending');

    config.oneShotArgs = ['--stale2'];
    rc.requestRestart(undefined, { type: 'manual', trigger: 'rs' });
    assert.strictEqual(config.oneShotArgs, null, 'manual clears pending');

    config.oneShotArgs = ['--keep'];
    rc.requestRestart(['a.js'], { type: 'watch', files: ['a.js'] });
    assert.deepEqual(config.oneShotArgs, ['--keep'], 'watch leaves pending');

    config.oneShotArgs = ['--keep2'];
    rc.requestRestart(undefined, { type: 'signal', signal: 'SIGHUP' });
    assert.deepEqual(config.oneShotArgs, ['--keep2'], 'signal leaves pending');

    bus.removeListener('restart', onRestart);
    config.oneShotArgs = null;
  });

  it('requestRestart with safe args queues one-shot', function () {
    var config = require('../../lib/config');
    config.commandBase = { executable: 'node', args: ['app.js'] };
    config.oneShotArgs = null;

    var bus = require('../../lib/utils').bus;
    var saw = null;
    function onRestart(files, reason) {
      saw = reason;
    }
    bus.on('restart', onRestart);

    var ok = rc.requestRestart(undefined, {
      type: 'manual',
      trigger: 'rs',
      args: ['--port', '4000'],
    });
    bus.removeListener('restart', onRestart);

    assert.strictEqual(ok, true);
    assert.deepEqual(config.oneShotArgs, ['--port', '4000']);
    assert.deepEqual(saw.args, ['--port', '4000']);
    config.oneShotArgs = null;
  });
});


describe('restart-cmd materializeCommand / one-shot lifecycle', function () {
  it('appends one-shot args once then restores original', function () {
    var config = {
      commandBase: { executable: 'node', args: ['app.js', '--base'] },
      oneShotArgs: ['--once', '1'],
      command: null,
    };

    var first = rc.materializeCommand(config);
    assert.deepEqual(first.args, ['app.js', '--base', '--once', '1']);
    assert.strictEqual(config.oneShotArgs, null);
    assert.ok(config.command.string.indexOf('--once') !== -1);

    var second = rc.materializeCommand(config);
    assert.deepEqual(second.args, ['app.js', '--base']);
    assert.ok(config.command.string.indexOf('--once') === -1);
  });

  it('plain setOneShotArgs(null) keeps original command', function () {
    var config = {
      commandBase: { executable: 'node', args: ['app.js'] },
      oneShotArgs: ['--stale'],
      command: null,
    };
    rc.setOneShotArgs(config, null);
    assert.strictEqual(config.oneShotArgs, null);
    var cmd = rc.materializeCommand(config);
    assert.deepEqual(cmd.args, ['app.js']);
  });

  it('does not mutate commandBase when applying one-shot', function () {
    var baseArgs = ['app.js'];
    var config = {
      commandBase: { executable: 'node', args: baseArgs },
      oneShotArgs: ['--x'],
      command: null,
    };
    rc.materializeCommand(config);
    assert.deepEqual(config.commandBase.args, ['app.js']);
    assert.deepEqual(baseArgs, ['app.js']);
  });
});

describe('formatRestartReason with one-shot args', function () {
  it('includes args for manual and api reasons', function () {
    assert.equal(
      rr.formatRestartReason({
        type: 'manual',
        trigger: 'rs',
        args: ['--port', '3'],
      }),
      'manual (rs) with args: --port 3'
    );
    assert.equal(
      rr.formatRestartReason({ type: 'api', args: ['--a'] }),
      'api (nodemon.restart) with args: --a'
    );
    assert.equal(
      rr.formatRestartReason({ type: 'manual', trigger: 'rs' }),
      'manual (rs)'
    );
  });
});

describe('one-shot rs args (integration)', function () {
  var nodemon = require('../../lib/');
  var tmp;
  var scriptBody = 'setInterval(function () {}, 60000);\n';

  beforeEach(function () {
    tmp = path.resolve(
      'test/fixtures/test-oneshot-' +
        crypto.randomBytes(8).toString('hex') +
        '.js'
    );
    fs.writeFileSync(tmp, scriptBody);
  });

  afterEach(function (done) {
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
    setTimeout(finish, 200);
  });

  function trackCommands(onReady) {
    var commands = [];
    return function onStart() {
      commands.push(
        (nodemon.config.command && nodemon.config.command.string) || ''
      );
      onReady(commands, commands.length);
    };
  }

  it('rs via API with args is one-shot; next restart restores original', function (done) {
    this.timeout(20000);
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
    })
      .on(
        'start',
        trackCommands(function (commands, n) {
          if (n === 1) {
            assert.ok(
              commands[0].indexOf('--one-shot') === -1,
              'initial has no one-shot args: ' + commands[0]
            );
            setTimeout(function () {
              nodemon.restart({ args: ['--one-shot', 'yes'] });
            }, 300);
          } else if (n === 2) {
            assert.ok(
              commands[1].indexOf('--one-shot') !== -1 &&
                commands[1].indexOf('yes') !== -1,
              'one-shot applied: ' + commands[1]
            );
            setTimeout(function () {
              nodemon.restart();
            }, 300);
          } else if (n === 3) {
            try {
              assert.ok(
                commands[2].indexOf('--one-shot') === -1,
                'restored original: ' + commands[2]
              );
              assert.equal(commands[2], commands[0]);
              finish();
            } catch (e) {
              finish(e);
            }
          }
        })
      )
      .on('crash', function () {
        finish(new Error('child crashed unexpectedly'));
      });
  });

  it('manual restart path applies rs <args> then restores on plain restart', function (done) {
    this.timeout(20000);
    var parsed = rc.parseRestartLine('rs --from-stdin 1', 'rs');
    assert(parsed && parsed.extraArgs.length === 2);
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
    }).on(
      'start',
      trackCommands(function (commands, n) {
        if (n === 1) {
          setTimeout(function () {
            rc.requestRestart(undefined, {
              type: 'manual',
              trigger: 'rs',
              args: parsed.extraArgs,
            });
          }, 300);
        } else if (n === 2) {
          try {
            assert.ok(
              commands[1].indexOf('--from-stdin') !== -1,
              'manual one-shot applied: ' + commands[1]
            );
          } catch (e) {
            return finish(e);
          }
          setTimeout(function () {
            rc.requestRestart(undefined, { type: 'manual', trigger: 'rs' });
          }, 300);
        } else if (n === 3) {
          try {
            assert.ok(
              commands[2].indexOf('--from-stdin') === -1,
              'plain rs restored: ' + commands[2]
            );
            assert.equal(commands[2], commands[0]);
            finish();
          } catch (e) {
            finish(e);
          }
        }
      })
    );
  });


  it('unsafe one-shot args via API do not change the running command', function (done) {
    this.timeout(15000);
    var settled = false;
    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      done(err);
    }
    var starts = 0;
    var original = null;

    nodemon({
      script: tmp,
      ext: 'js',
      stdout: false,
      restartable: false,
    }).on('start', function () {
      starts += 1;
      var cmd = nodemon.config.command.string;
      if (starts === 1) {
        original = cmd;
        setTimeout(function () {
          nodemon.restart({ args: ['&&', 'echo', 'pwn'] });
          setTimeout(function () {
            try {
              assert.equal(starts, 1, 'no restart after unsafe args');
              assert.equal(nodemon.config.command.string, original);
              assert.strictEqual(nodemon.config.oneShotArgs, null);
              finish();
            } catch (e) {
              finish(e);
            }
          }, 500);
        }, 300);
      }
    });
  });

  it('watch restart after one-shot does not keep extra args', function (done) {
    this.timeout(25000);
    var touch = require('touch');
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
      delay: 200,
    }).on(
      'start',
      trackCommands(function (commands, n) {
        if (n === 1) {
          setTimeout(function () {
            nodemon.restart({ args: ['--watch-me'] });
          }, 300);
        } else if (n === 2) {
          try {
            assert.ok(
              commands[1].indexOf('--watch-me') !== -1,
              'one-shot on run 2: ' + commands[1]
            );
          } catch (e) {
            return finish(e);
          }
          setTimeout(function () {
            touch.sync(tmp);
          }, 400);
        } else if (n === 3) {
          try {
            assert.ok(
              commands[2].indexOf('--watch-me') === -1,
              'watch restart drops one-shot: ' + commands[2]
            );
            assert.equal(commands[2], commands[0]);
            finish();
          } catch (e) {
            finish(e);
          }
        }
      })
    );
  });

  it('restart reason includes args for one-shot api restart', function (done) {
    this.timeout(15000);
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
    })
      .once('start', function () {
        setTimeout(function () {
          nodemon.restart({ args: ['--r'] });
        }, 300);
      })
      .once('restart', function (files, reason) {
        try {
          assert(reason, 'reason present');
          assert.equal(reason.type, 'api');
          assert.deepEqual(reason.args, ['--r']);
        } catch (e) {
          return finish(e);
        }
        nodemon.once('start', function () {
          var cmd = nodemon.config.command.string;
          try {
            assert.ok(cmd.indexOf('--r') !== -1, 'cmd has one-shot: ' + cmd);
            finish();
          } catch (e) {
            finish(e);
          }
        });
      });
  });

  it('child process.argv actually receives one-shot args', function (done) {
    this.timeout(15000);
    var probe = path.resolve(
      'test/fixtures/test-oneshot-probe-' +
        crypto.randomBytes(8).toString('hex') +
        '.js'
    );
    fs.writeFileSync(
      probe,
      "console.log('ARGV:' + JSON.stringify(process.argv.slice(2)));\n" +
        'setInterval(function () {}, 60000);\n'
    );
    var settled = false;
    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      try {
        fs.unlinkSync(probe);
      } catch (e) {}
      done(err);
    }

    var sawInitial = false;
    nodemon({
      script: probe,
      ext: 'js',
      stdout: false,
      restartable: false,
    })
      .on('stdout', function (data) {
        var s = data.toString();
        var m = s.match(/ARGV:(\[[\s\S]*?\])/);
        if (!m) {
          return;
        }
        var argv = JSON.parse(m[1]);
        if (!sawInitial) {
          sawInitial = true;
          assert.deepEqual(argv, []);
          setTimeout(function () {
            nodemon.restart({ args: ['--live', '1'] });
          }, 200);
          return;
        }
        try {
          assert.deepEqual(argv, ['--live', '1']);
          finish();
        } catch (e) {
          finish(e);
        }
      })
      .on('crash', function () {
        finish(new Error('crashed'));
      });
  });
});
