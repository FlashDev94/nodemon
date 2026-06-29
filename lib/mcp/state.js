'use strict';

/**
 * In-memory runtime snapshot for MCP tools.
 * Only populated when MCP mode is enabled (bindBus called).
 */

var MAX_LOGS = 200;
var MAX_HISTORY = 50;
var MAX_WATCHED = 5000;

var state = {
  enabled: false,
  status: 'idle',
  startedAt: null,
  lastStartAt: null,
  lastExitAt: null,
  lastExitCode: null,
  childPid: null,
  restartCount: 0,
  watchedFiles: [],
  watchedSet: Object.create(null),
  restartHistory: [],
  logs: [],
  lastReason: null,
  configSummary: null,
  bound: false,
};

function pushLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_LOGS);
  }
}

function pushHistory(entry) {
  state.restartHistory.push(entry);
  if (state.restartHistory.length > MAX_HISTORY) {
    state.restartHistory.splice(0, state.restartHistory.length - MAX_HISTORY);
  }
}

function addWatched(file) {
  if (!file || state.watchedSet[file]) {
    return;
  }
  if (state.watchedFiles.length >= MAX_WATCHED) {
    return;
  }
  state.watchedSet[file] = true;
  state.watchedFiles.push(file);
}

function snapshotConfig(cfg) {
  if (!cfg || !cfg.options) {
    return null;
  }
  return {
    cwd: cfg.system && cfg.system.cwd,
    command: cfg.command && cfg.command.string,
    watch: cfg.options.watch,
    ignore: cfg.options.ignore,
    ext: cfg.options.execOptions && cfg.options.execOptions.ext,
    restartOn: cfg.options.restartOn,
    restartLoopGuard: cfg.options.restartLoopGuard,
    startUpWatchDelay: cfg.options.startUpWatchDelay,
    delay: cfg.options.delay,
    script: cfg.options.execOptions && cfg.options.execOptions.script,
    mcp: !!cfg.options.mcp,
    mcpPort: cfg.options.mcpPort,
  };
}

/**
 * Subscribe to nodemon bus events. Safe to call once when MCP starts.
 */
function bindBus(bus, config) {
  if (state.bound) {
    return state;
  }
  state.bound = true;
  state.enabled = true;
  state.startedAt = new Date().toISOString();

  bus.on('start', function () {
    state.status = 'running';
    state.lastStartAt = new Date().toISOString();
  });

  bus.on('restart', function (files, reason) {
    state.status = 'restarting';
    state.restartCount += 1;
    state.lastReason = reason || { type: 'unknown' };
    pushHistory({
      at: new Date().toISOString(),
      files: files || null,
      reason: reason || null,
    });
  });

  bus.on('crash', function () {
    state.status = 'crashed';
  });

  bus.on('exit', function (code) {
    state.status = 'exited';
    state.lastExitAt = new Date().toISOString();
    state.lastExitCode = code;
    state.childPid = null;
  });

  bus.on('quit', function () {
    state.status = 'quitting';
  });

  bus.on('watching', function (file) {
    addWatched(file);
  });

  bus.on('log', function (entry) {
    var message = (entry && entry.message) || '';
    pushLog({
      at: new Date().toISOString(),
      type: (entry && entry.type) || 'log',
      message: message,
    });
    // detail logs include "child pid: N" (always emitted on bus, even if not verbose to console)
    var m = message.match(/child pid:\s*(\d+)/i);
    if (m) {
      state.childPid = parseInt(m[1], 10);
    }
  });

  bus.on('config:update', function (cfg) {
    try {
      state.configSummary = snapshotConfig(cfg);
    } catch (e) {
      state.configSummary = { error: String(e.message || e) };
    }
  });

  if (config) {
    state.configSummary = snapshotConfig(config);
  }

  return state;
}

function getSnapshot() {
  return {
    status: state.status,
    enabled: state.enabled,
    startedAt: state.startedAt,
    lastStartAt: state.lastStartAt,
    lastExitAt: state.lastExitAt,
    lastExitCode: state.lastExitCode,
    childPid: state.childPid,
    restartCount: state.restartCount,
    lastReason: state.lastReason,
    watchedFileCount: state.watchedFiles.length,
    config: state.configSummary,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime() * 1000) / 1000,
  };
}

function getWatchedFiles(limit) {
  var n = typeof limit === 'number' && limit > 0 ? limit : 200;
  return state.watchedFiles.slice(0, n);
}

function getRestartHistory(limit) {
  var n = typeof limit === 'number' && limit > 0 ? limit : 50;
  return state.restartHistory.slice(-n);
}

function getLogs(limit, typeFilter) {
  var n = typeof limit === 'number' && limit > 0 ? limit : 100;
  var logs = state.logs;
  if (typeFilter) {
    logs = logs.filter(function (l) {
      return l.type === typeFilter;
    });
  }
  return logs.slice(-n);
}

function resetState() {
  state.enabled = false;
  state.bound = false;
  state.status = 'idle';
  state.watchedFiles = [];
  state.watchedSet = Object.create(null);
  state.restartHistory = [];
  state.logs = [];
  state.restartCount = 0;
  state.childPid = null;
  state.lastReason = null;
  state.configSummary = null;
  state.startedAt = null;
  state.lastStartAt = null;
  state.lastExitAt = null;
  state.lastExitCode = null;
}

module.exports = {
  bindBus: bindBus,
  getSnapshot: getSnapshot,
  getWatchedFiles: getWatchedFiles,
  getRestartHistory: getRestartHistory,
  getLogs: getLogs,
  resetState: resetState,
  _state: state,
};
