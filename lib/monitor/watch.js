module.exports.watch = watch;
module.exports.resetWatchers = resetWatchers;

var debug = require('debug')('nodemon:watch');
var debugRoot = require('debug')('nodemon');
var chokidar = require('chokidar');
var undefsafe = require('undefsafe');
var config = require('../config');
var path = require('path');
var utils = require('../utils');
var bus = utils.bus;
var match = require('./match');
var requestRestart = require('./restart-cmd').requestRestart;
var watchers = [];
var debouncedBus;
// timestamps of file-change restarts (for restartLoopGuard)
var restartTimestamps = [];

// default guard when restartLoopGuard is `true` or a bare number
var DEFAULT_RESTART_LOOP_MAX = 10;
var DEFAULT_RESTART_LOOP_WINDOW_MS = 10000;

bus.on('reset', function () {
  resetWatchers();
  restartTimestamps = [];
  debouncedBus = undefined;
});

function resetWatchers() {
  debugRoot('resetting watchers');
  watchers.forEach(function (watcher) {
    watcher.close();
  });
  watchers = [];
}

function watch() {
  if (watchers.length) {
    debug('early exit on watch, still watching (%s)', watchers.length);
    return;
  }

  var dirs = [].slice.call(config.dirs);

  debugRoot('start watch on: %s', dirs.join(', '));
  const rootIgnored = config.options.ignore;
  debugRoot('ignored', rootIgnored);

  var watchedFiles = [];

  const promise = new Promise(function (resolve) {
    const dotFilePattern = /[/\\]\./;
    var ignored = match.rulesToMonitor(
      [], // not needed
      Array.from(rootIgnored),
      config
    ).map(pattern => pattern.slice(1));

    const addDotFile = dirs.filter(dir => dir.match(dotFilePattern));

    // don't ignore dotfiles if explicitly watched.
    if (addDotFile.length === 0) {
      ignored.push(dotFilePattern);
    }

    var watchOptions = {
      ignorePermissionErrors: true,
      ignored: ignored,
      persistent: true,
      usePolling: config.options.legacyWatch || false,
      interval: config.options.pollingInterval,
      // note to future developer: I've gone back and forth on adding `cwd`
      // to the props and in some cases it fixes bugs but typically it causes
      // bugs elsewhere (since nodemon is used is so many ways). the final
      // decision is to *not* use it at all and work around it
      // cwd: ...
    };

    if (utils.isWindows) {
      watchOptions.disableGlobbing = true;
    }

    if (utils.isIBMi) {
      watchOptions.usePolling = true;
    }

    if (process.env.TEST) {
      watchOptions.useFsEvents = false;
    }

    var watcher = chokidar.watch(
      dirs,
      Object.assign({}, watchOptions, config.options.watchOptions || {})
    );

    watcher.ready = false;

    var total = 0;

    // restartOn filters which FS events trigger a restart. Default 'all'
    // preserves historical behavior (change + add + unlink).
    watcher.on('change', function (file) {
      if (!shouldRestartOnEvent('change')) {
        utils.log.detail('ignoring change event (restartOn filter)');
        return;
      }
      filterAndRestart(file);
    });
    watcher.on('unlink', function (file) {
      // keep MCP / consumers' watched-file lists accurate
      bus.emit('unwatch', file);
      if (!shouldRestartOnEvent('unlink')) {
        utils.log.detail('ignoring unlink event (restartOn filter)');
        return;
      }
      filterAndRestart(file);
    });
    watcher.on('add', function (file) {
      if (watcher.ready) {
        if (!shouldRestartOnEvent('add')) {
          utils.log.detail('ignoring add event (restartOn filter)');
          return;
        }
        return filterAndRestart(file);
      }

      watchedFiles.push(file);
      bus.emit('watching', file);
      debug('chokidar watching: %s', file);
    });
    watcher.on('ready', function () {
      watchedFiles = Array.from(new Set(watchedFiles)); // ensure no dupes
      total = watchedFiles.length;
      watcher.ready = true;
      resolve(total);
      debugRoot('watch is complete');
    });

    watcher.on('error', function (error) {
      if (error.code === 'EINVAL') {
        utils.log.error(
          'Internal watch failed. Likely cause: too many ' +
          'files being watched (perhaps from the root of a drive?\n' +
          'See https://github.com/paulmillr/chokidar/issues/229 for details'
        );
      } else {
        utils.log.error('Internal watch failed: ' + error.message);
        process.exit(1);
      }
    });

    watchers.push(watcher);
  });

  return promise.catch(e => {
    // this is a core error and it should break nodemon - so I have to break
    // out of a promise using the setTimeout
    setTimeout(() => {
      throw e;
    });
  }).then(function () {
    utils.log.detail(`watching ${watchedFiles.length} file${
      watchedFiles.length === 1 ? '' : 's'}`);
    return watchedFiles;
  });
}

function filterAndRestart(files) {
  if (!Array.isArray(files)) {
    files = [files];
  }

  if (files.length) {
    var cwd = process.cwd();
    if (this.options && this.options.cwd) {
      cwd = this.options.cwd;
    }

    utils.log.detail(
      'files triggering change check: ' +
      files
        .map(file => {
          const res = path.relative(cwd, file);
          return res;
        })
        .join(', ')
    );

    // make sure the path is right and drop an empty
    // filenames (sometimes on windows)
    files = files.filter(Boolean).map(file => {
      return path.relative(process.cwd(), path.relative(cwd, file));
    });

    if (utils.isWindows) {
      // ensure the drive letter is in uppercase (c:\foo -> C:\foo)
      files = files.map(f => {
        if (f.indexOf(':') === -1) { return f; }
        return f[0].toUpperCase() + f.slice(1);
      });
    }


    debug('filterAndRestart on', files);

    var matched = match(
      files,
      config.options.monitor,
      undefsafe(config, 'options.execOptions.ext')
    );

    debug('matched?', JSON.stringify(matched));

    // if there's no matches, then test to see if the changed file is the
    // running script, if so, let's allow a restart
    if (config.options.execOptions && config.options.execOptions.script) {
      const script = path.resolve(config.options.execOptions.script);
      if (matched.result.length === 0 && script) {
        const length = script.length;
        files.find(file => {
          if (file.substr(-length, length) === script) {
            matched = {
              result: [file],
              total: 1,
            };
            return true;
          }
        });
      }
    }

    utils.log.detail(
      'changes after filters (before/after): ' +
      [files.length, matched.result.length].join('/')
    );

    if (matched.result.length) {
      // Ignore changes for a short period right after the child process starts
      // (startUpWatchDelay). Distinct from `delay`, which debounces restarts
      // after a change is detected. Do NOT advance lastStarted for ignored
      // events — that would skew early-exit / timing logic in run.js.
      if (config.ignoreWatchUntil && Date.now() < config.ignoreWatchUntil) {
        utils.log.detail(
          'ignoring change during startUpWatchDelay (' +
            (config.ignoreWatchUntil - Date.now()) +
            'ms remaining)'
        );
        return;
      }

      // reset the last check so we're only looking at recently modified files
      config.lastStarted = Date.now();

      if (config.options.delay > 0) {
        utils.log.detail('delaying restart for ' + config.options.delay + 'ms');
        if (debouncedBus === undefined) {
          debouncedBus = debounce(restartBus, config.options.delay);
        }
        debouncedBus(matched);
      } else {
        return restartBus(matched);
      }
    } else {
      // non-matching changes still advance lastStarted (historical behavior)
      config.lastStarted = Date.now();
    }
  }
}

/**
 * Normalize restartLoopGuard option to { max, window } or null when disabled.
 * Unsupported / unset values leave normal restart behavior unchanged.
 *
 * @param {*} guard
 * @return {{max:number,window:number}|null}
 */
function normalizeRestartLoopGuard(guard) {
  if (!guard) {
    return null;
  }

  if (guard === true) {
    return {
      max: DEFAULT_RESTART_LOOP_MAX,
      window: DEFAULT_RESTART_LOOP_WINDOW_MS,
    };
  }

  if (typeof guard === 'number' && guard > 0) {
    return {
      max: guard,
      window: DEFAULT_RESTART_LOOP_WINDOW_MS,
    };
  }

  if (typeof guard === 'object' && guard.max > 0) {
    return {
      max: guard.max,
      window: guard.window > 0 ? guard.window : DEFAULT_RESTART_LOOP_WINDOW_MS,
    };
  }

  return null;
}

function restartBus(matched) {
  var guard = normalizeRestartLoopGuard(config.options.restartLoopGuard);
  if (guard) {
    var now = Date.now();
    restartTimestamps = restartTimestamps.filter(function (t) {
      return now - t < guard.window;
    });

    if (restartTimestamps.length >= guard.max) {
      utils.log.error(
        'restart loop detected: ' +
          restartTimestamps.length +
          ' restarts within ' +
          guard.window +
          'ms (limit ' +
          guard.max +
          ')'
      );
      utils.log.error(
        'pausing automatic restarts — wait for the window to pass, ' +
          'or type `' +
          (config.options.restartable || 'rs') +
          '` to force a restart'
      );
      return;
    }

    restartTimestamps.push(now);
  }

  utils.log.status('restarting due to changes...');
  matched.result.map(file => {
    utils.log.detail(path.relative(process.cwd(), file));
  });

  if (config.options.verbose) {
    utils.log._log('');
  }

  // watch leaves a pending one-shot alone so concurrent `rs <args>` is not lost
  requestRestart(matched.result, { type: 'watch', files: matched.result });
}

// exported for tests
module.exports.normalizeRestartLoopGuard = normalizeRestartLoopGuard;
module.exports.shouldRestartOnEvent = shouldRestartOnEvent;

var ALLOWED_RESTART_ON = {
  change: true,
  add: true,
  unlink: true,
  all: true,
};

// warn once per process for invalid restartOn config
var warnedInvalidRestartOn = false;

/**
 * Whether a chokidar event type should trigger a restart, based on restartOn.
 * Unset / 'all' / invalid values => true (backward compatible).
 *
 * @param {string} eventName 'change' | 'add' | 'unlink'
 * @return {boolean}
 */
function shouldRestartOnEvent(eventName) {
  var on = config.options && config.options.restartOn;

  if (on === undefined || on === null || on === '' || on === 'all') {
    return true;
  }

  var list;
  if (Array.isArray(on)) {
    list = on;
  } else {
    list = String(on).split(/[,\s]+/);
  }

  list = list
    .map(function (p) {
      return String(p).trim().toLowerCase();
    })
    .filter(Boolean);

  if (list.length === 0 || list.indexOf('all') !== -1) {
    return true;
  }

  var unknown = list.filter(function (p) {
    return !ALLOWED_RESTART_ON[p];
  });
  if (unknown.length) {
    if (!warnedInvalidRestartOn) {
      warnedInvalidRestartOn = true;
      utils.log.error(
        'invalid restartOn value(s): ' +
          unknown.join(', ') +
          ' (allowed: change, add, unlink, all) — falling back to all events'
      );
    }
    return true;
  }

  return list.indexOf(String(eventName).toLowerCase()) !== -1;
}

// test helper: reset one-shot warning flag
module.exports._resetRestartOnWarning = function () {
  warnedInvalidRestartOn = false;
};

function debounce(fn, delay) {
  var timer = null;
  return function () {
    const context = this;
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() =>fn.apply(context, args), delay);
  };
}
