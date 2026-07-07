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
  // when true, print restart reason at status level (always visible).
  // Reason is always passed as the 2nd arg to the `restart` event either way.
  restartReason: false,
  // Which FS events trigger a restart: 'all' (default = change + add + unlink),
  // or 'change', 'add', 'unlink', or a list / comma-separated string of those.
  restartOn: 'all',
  // Opt-in MCP server (false = off; normal nodemon behavior unchanged)
  mcp: false,
  mcpPort: 8765,
  mcpHost: '127.0.0.1',
  // 'http' (SSE + REST on mcpPort) or 'stdio'
  mcpTransport: 'http',
  // Shared secret for HTTP MCP/REST (optional on loopback; required with remote bind)
  mcpToken: null,
  // Allow binding MCP to non-loopback hosts (requires mcpToken)
  mcpAllowRemote: false,
};

const nodeOptions = process.env.NODE_OPTIONS || ''; // ?

if (/--(loader|import)\b/.test(nodeOptions)) {
  delete defaults.execMap.ts;
}

module.exports = defaults;
