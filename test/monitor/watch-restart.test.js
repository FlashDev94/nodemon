'use strict';
/*global describe, it, after, afterEach */
let debugLogger = {};
const nodemon = require('../../lib/');
var assert = require('assert');
var fs = require('fs');
var utils = require('../utils');
var path = require('path');
var touch = require('touch');
var crypto = require('crypto');
var baseFilename =
  'test/fixtures/test' + crypto.randomBytes(16).toString('hex');

var WAIT_BEFORE_START = 3000;

describe('nodemon monitor child restart', function () {
  var tmpjs = path.resolve(baseFilename + '.js');
  var tmpmd = path.resolve(baseFilename + '.md');

  function write(both) {
    fs.writeFileSync(tmpjs, 'true;');
    if (both) {
      fs.writeFileSync(tmpmd, '# true');
    }
  }

  var pwd = process.cwd();
  var oldhome = utils.home;

  afterEach(function () {
    debugLogger = {};
    process.chdir(pwd);
    utils.home = oldhome;

    if (fs.existsSync(tmpjs)) {
      fs.unlinkSync(tmpjs);
    }
    if (fs.existsSync(tmpmd)) {
      fs.unlinkSync(tmpmd);
    }
  });

  after(function (done) {
    nodemon
      .once('exit', function () {
        nodemon.reset(done);
      })
      .emit('quit');
  });

  it('should happen when monitoring a single extension', function (done) {
    write();

    setTimeout(function () {
      nodemon({ script: tmpjs, verbose: true, ext: 'js' })
        .on('start', function () {
          setTimeout(function () {
            touch.sync(tmpjs);
          }, 1500);
        })
        .on('restart', function (files) {
          assert(
            files[0] === tmpjs,
            'nodemon restarted because of change to our file' + files
          );
          nodemon
            .once('exit', function () {
              nodemon.reset(done);
            })
            .emit('quit');
        });
    }, WAIT_BEFORE_START);
  });

  it('should happen when monitoring multiple extensions', function (done) {
    write(true);
    setTimeout(function () {
      nodemon({
        script: tmpjs,
        ext: 'js md',
        verbose: true,
      })
        .on('start', function () {
          setTimeout(function () {
            touch.sync(tmpmd);
          }, 1500);
        })
        .on('log', function (event) {
          var msg = event.message;
          if (utils.match(msg, 'changes after filters')) {
            var changes = msg
              .trim()
              .slice(-5)
              .split('/');
            var restartedOn = changes.pop();
            assert(
              restartedOn === '1',
              'nodemon restarted on a single file change'
            );
            nodemon
              .once('exit', function () {
                nodemon.reset(done);
              })
              .emit('quit');
          }
        });
    }, WAIT_BEFORE_START);
  });

  if (process.platform === 'darwin') {
    it('should restart when watching directory (mac only)', function (done) {
      write(true);

      process.chdir('test/fixtures');

      setTimeout(function () {
        nodemon({
          script: tmpjs,
          verbose: true,
          ext: 'js',
          watch: ['*.js', 'global'],
        })
          .on('start', function () {
            setTimeout(function () {
              touch.sync(tmpjs);
            }, 1000);
          })
          .on('restart', function (files) {
            assert(
              files.length === 1,
              'nodemon restarted when watching directory'
            );
            nodemon
              .once('exit', function () {
                nodemon.reset(done);
              })
              .emit('quit');
          });
      }, WAIT_BEFORE_START);
    });
  }

  it('should restart when watching directory', function (done) {
    write(true);

    // process.chdir(process.cwd() + '/test/fixtures');

    setTimeout(function () {
      nodemon({
        script: tmpjs,
        verbose: true,
        ext: 'js md',
        watch: ['test/'],
      })
        .on('start', function () {
          setTimeout(function () {
            touch.sync(tmpmd);
          }, 1000);
        })
        .on('restart', function (files) {
          assert(
            files.length === 1,
            'nodemon restarted when watching directory'
          );
          nodemon
            .once('exit', function () {
              nodemon.reset(done);
            })
            .emit('quit');
        });
    }, WAIT_BEFORE_START);
  });

  it('should ignore relative node_modules', done => {
    write(true);

    process.chdir(process.cwd() + '/test/fixtures/1246/app');

    nodemon({
      script: 'index.js',
      watch: ['../'],
    })
      .on('watching', file => {
        assert(
          file.indexOf('/node_modules/') === -1,
          `node_modules found: ${file}`
        );
      })
      .on('start', () => {
        // gentle timeout to wait for the files to finish reading
        setTimeout(() => {
          nodemon
            .once('exit', function () {
              nodemon.reset(done);
            })
            .emit('quit');
        }, 1000);
      });
  });

  it('should ignore file changes during startUpWatchDelay', function (done) {
    write();
    var restarted = false;
    var settled = false;
    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      nodemon.reset(function () {
        done(err);
      });
    }

    setTimeout(function () {
      nodemon({
        script: tmpjs,
        verbose: true,
        ext: 'js',
        // ignore changes for 2s after the child starts
        startUpWatchDelay: 2000,
      })
        .once('start', function () {
          // touch while still inside the startup ignore window
          setTimeout(function () {
            touch.sync(tmpjs);
          }, 200);
        })
        .on('restart', function () {
          restarted = true;
        });

      // after startUpWatchDelay has elapsed, we should not have restarted
      setTimeout(function () {
        try {
          assert(
            restarted === false,
            'nodemon must not restart during startUpWatchDelay'
          );
        } catch (err) {
          nodemon.once('exit', function () {
            finish(err);
          }).emit('quit');
          return;
        }
        nodemon.once('exit', function () {
          finish();
        }).emit('quit');
      }, 2500);
    }, WAIT_BEFORE_START);
  });

  it('should not apply restartLoopGuard when option is unset', function (done) {
    write();
    var restarts = 0;
    var settled = false;
    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      nodemon.reset(function () {
        done(err);
      });
    }

    setTimeout(function () {
      // no restartLoopGuard — normal restart behavior
      nodemon({
        script: tmpjs,
        verbose: true,
        ext: 'js',
      })
        .once('start', function () {
          setTimeout(function () {
            touch.sync(tmpjs);
          }, 800);
        })
        .once('restart', function () {
          restarts++;
          try {
            assert(restarts === 1, 'normal restart should still occur');
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
    }, WAIT_BEFORE_START);
  });

  it('should pause automatic restarts when restartLoopGuard trips', function (done) {
    write();
    var restarts = 0;
    var sawLoopWarning = false;
    var settled = false;
    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      nodemon.reset(function () {
        done(err);
      });
    }

    setTimeout(function () {
      nodemon({
        script: tmpjs,
        verbose: true,
        ext: 'js',
        // trip quickly: 2 restarts within 5s
        restartLoopGuard: { max: 2, window: 5000 },
      })
        .on('start', function () {
          // hammer the file so we attempt more than `max` restarts
          var n = 0;
          var iv = setInterval(function () {
            n++;
            touch.sync(tmpjs);
            if (n >= 6) {
              clearInterval(iv);
            }
          }, 200);
        })
        .on('restart', function () {
          restarts++;
        })
        .on('log', function (event) {
          if (
            event &&
            event.message &&
            /restart loop detected/i.test(event.message)
          ) {
            sawLoopWarning = true;
          }
        });

      setTimeout(function () {
        try {
          assert(
            restarts <= 2,
            'expected at most 2 automatic restarts, got ' + restarts
          );
          assert(
            sawLoopWarning === true,
            'expected a clear restart-loop warning in logs'
          );
        } catch (err) {
          nodemon.once('exit', function () {
            finish(err);
          }).emit('quit');
          return;
        }
        nodemon.once('exit', function () {
          finish();
        }).emit('quit');
      }, 3500);
    }, WAIT_BEFORE_START);
  });

  it('should restart after startUpWatchDelay expires', function (done) {
    write();
    var settled = false;
    function finish(err) {
      if (settled) {
        return;
      }
      settled = true;
      nodemon.reset(function () {
        done(err);
      });
    }

    setTimeout(function () {
      nodemon({
        script: tmpjs,
        verbose: true,
        ext: 'js',
        startUpWatchDelay: 500,
      })
        .once('start', function () {
          // wait until after the startup ignore window, then touch
          setTimeout(function () {
            touch.sync(tmpjs);
          }, 1000);
        })
        .once('restart', function (files) {
          try {
            assert(
              files && files.length > 0,
              'nodemon should restart after startUpWatchDelay expires'
            );
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
    }, WAIT_BEFORE_START);
  });
});
