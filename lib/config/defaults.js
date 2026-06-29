var ignoreRoot = require('ignore-by-default').directories();

// default options for config.options
const defaults = {
  restartable: 'rs',
  colours: true,
  execMap: {
    py: 'python',
    rb: 'ruby',
    ts: 'ts-node',
    // more can be added here such as ls: lsc - but please ensure it's cross
    // compatible with linux, mac and windows, or make the default.js
    // dynamically append the `.cmd` for node based utilities
  },
  ignoreRoot: ignoreRoot.map((_) => `**/${_}/**`),
  watch: ['*.*'],
  stdin: true,
  runOnChangeOnly: false,
  verbose: false,
  signal: 'SIGUSR2',
  // 'stdout' refers to the default behaviour of a required nodemon's child,
  // but also includes stderr. If this is false, data is still dispatched via
  // nodemon.on('stdout/stderr')
  stdout: true,
  watchOptions: {},
  // ignore file changes for this many ms after the child process starts
  // (avoids restart loops when apps write generated files on startup)
  startUpWatchDelay: 0,
  // when set (true | number | { max, window }), pause automatic restarts if
  // too many file-change restarts happen within the time window. false = off
  // (default). Does not affect normal restart behavior when unset/false.
  restartLoopGuard: false,
  // Which FS events trigger a restart: 'all' (default = change + add + unlink),
  // or 'change', 'add', 'unlink', or a list / comma-separated string of those.
  restartOn: 'all',
};

const nodeOptions = process.env.NODE_OPTIONS || ''; // ?

if (/--(loader|import)\b/.test(nodeOptions)) {
  delete defaults.execMap.ts;
}

module.exports = defaults;
