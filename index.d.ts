import type { WatchOptions } from 'chokidar';

export type NodemonEventHandler =
  | 'start'
  | 'crash'
  | 'exit'
  | 'quit'
  | 'restart'
  | 'config:update'
  | 'log'
  | 'readable'
  | 'stdout'
  | 'stderr';

export type NodemonEventListener = {
  on(event: 'readable', listener: () => void): Nodemon;
  /** Optional child pid is passed when available (listeners may ignore it). */
  on(event: 'start', listener: (pid?: number) => void): Nodemon;
  /** Optional exit code is passed when available (listeners may ignore it). */
  on(event: 'crash', listener: (code?: number | null) => void): Nodemon;
  on(event: 'log', listener: (e: NodemonEventLog) => void): Nodemon;
  on(event: 'stdout' | 'stderr', listener: (e: string) => void): Nodemon;
  on(
    event: 'restart',
    listener: (files?: string[], reason?: NodemonRestartReason) => void,
  ): Nodemon;
  on(event: 'quit', listener: (e?: NodemonEventQuit) => void): Nodemon;
  on(event: 'exit', listener: (e?: number) => void): Nodemon;
  on(
    event: 'config:update',
    listener: (e?: NodemonEventConfig) => void,
  ): Nodemon;
};

/** Why nodemon restarted (2nd argument to the `restart` event). */
export type NodemonRestartReason = {
  /** watch = file change; manual = typed rs; api = nodemon.restart(); signal = process signal */
  type: 'watch' | 'manual' | 'api' | 'signal' | string;
  files?: string[];
  /** e.g. "rs" when type is manual */
  trigger?: string;
  /** e.g. "SIGHUP" when type is signal */
  signal?: string;
  /**
   * One-shot extra args for this restart only (`rs <args>` or
   * `nodemon.restart({ args })`). The following restart uses the original
   * command again.
   */
  args?: string[];
};

export type NodemonEventLog = {
  /**
    - detail: what you get with nodemon --verbose.
    - status: subprocess starting, restarting.
    - fail: is the subprocess crashing.
    - error: is a nodemon system error.
  */
  type: 'detail' | 'log' | 'status' | 'error' | 'fail';
  /** the plain text message */
  message: string;
  /** contains the terminal escape codes to add colour, plus the "[nodemon]" prefix */
  colour: string;
};

export type NodemonEventQuit = 143 | 130;

export type NodemonEventConfig = {
  run: boolean;
  system: {
    cwd: string;
  };
  required: boolean;
  dirs: string[];
  timeout: number;
  options: NodemonConfig;
  lastStarted: number;
  loaded: string[];
  load: (
    settings: NodemonSettings,
    ready: (config: NodemonEventConfig) => void,
  ) => void;
  reset: () => void;
};

export interface NodemonExecOptions {
  script: string;
  scriptPosition?: number;
  args?: string[];
  ext?: string; // "js,mjs" etc (should really support an array of strings, but I don't think it does right now)
  exec?: string; // node, python, etc
  execArgs?: string[]; // args passed to node, etc,
  nodeArgs?: string[]; // args passed to node, etc,
}

export interface NodemonConfig {
  /** restartable defaults to "rs" as a string the user enters */
  restartable?: false | string;
  colours?: boolean;
  execMap?: { [key: string]: string };
  ignoreRoot?: string[];
  watch?: string[];
  ignore?: string[];
  stdin?: boolean;
  runOnChangeOnly?: boolean;
  verbose?: boolean;
  signal?: string;
  /**
   * If the child has not exited this many ms after the stop/restart signal,
   * force-kill with SIGKILL. 0 / unset = disabled (default; wait indefinitely).
   */
  killTimeout?: number;
  stdout?: boolean;
  watchOptions?: WatchOptions;
  help?: string;
  version?: boolean;
  cwd?: string;
  dump?: boolean;
  delay?: number;
  /**
   * Milliseconds to ignore file changes after the child process starts.
   * Prevents restart loops when apps write generated files on startup.
   * Separate from `delay`, which debounces restarts after a file change.
   */
  startUpWatchDelay?: number;
  /**
   * Pause automatic file-change restarts when too many happen in a time window.
   * - false / unset: disabled (default; normal restart behavior)
   * - true: enable with defaults (10 restarts / 10000ms)
   * - number: max restarts in the default 10000ms window
   * - { max, window }: max restarts within window (ms)
   * Manual restart (`rs` / signal) is not blocked.
   */
  restartLoopGuard?:
    | boolean
    | number
    | {
        max: number;
        /** window in milliseconds */
        window?: number;
      };
  /**
   * When true, print restart reason at status level (always visible).
   * The `restart` event always receives reason as its 2nd argument regardless.
   * Default false (reason only in --verbose / detail logs).
   */
  restartReason?: boolean;
  /**
   * Which filesystem events trigger a restart.
   * - 'all' (default): change, add, and unlink — same as historical nodemon
   * - 'change' | 'add' | 'unlink': only that event
   * - array or comma-separated list, e.g. ['change','add'] or 'change,add'
   */
  restartOn?: 'all' | 'change' | 'add' | 'unlink' | string | string[];
  /**
   * Enable MCP server mode (default false). When false, behavior is unchanged
   * and MCP code is not started. SSE/stdio need optional dep
   * `@modelcontextprotocol/sdk` (Node >= 18); REST works without it.
   */
  mcp?: boolean;
  /** MCP HTTP port when using http transport (default 8765) */
  mcpPort?: number;
  /** MCP HTTP bind host (default 127.0.0.1 — loopback only) */
  mcpHost?: string;
  /** 'http' (SSE + REST) or 'stdio' */
  mcpTransport?: 'http' | 'stdio' | string;
  /**
   * Shared secret for MCP HTTP/REST. When set, required on all routes except
   * GET /health (Authorization: Bearer, X-Nodemon-Mcp-Token, or ?token=).
   * Required when binding a non-loopback host with mcpAllowRemote.
   */
  mcpToken?: string | null;
  /**
   * Allow binding MCP HTTP to a non-loopback host. Must be combined with
   * mcpToken. Default false.
   */
  mcpAllowRemote?: boolean;
  monitor?: string[];
  spawn?: boolean;
  noUpdateNotifier?: boolean;
  legacyWatch?: boolean;
  pollingInterval?: number;
  /** @deprecated as this is "on" by default */
  js?: boolean;
  quiet?: boolean;
  configFile?: string;
  exitCrash?: boolean;
  execOptions?: NodemonExecOptions;
}

export interface NodemonSettings extends NodemonConfig, NodemonExecOptions {
  events?: Record<string, string>;
  env?: Record<string, string>;
}

export type Nodemon = {
  (settings: NodemonSettings): Nodemon;
  removeAllListeners(event: NodemonEventHandler): Nodemon;
  emit(type: NodemonEventHandler, event?: any): Nodemon;
  reset(callback: Function): Nodemon;
  /** Optional reason is passed through to the restart event / history. */
  restart(reason?: NodemonRestartReason): Nodemon;
  config: NodemonSettings;
} & NodemonEventListener & {
    [K in keyof NodemonEventListener as 'addListener']: NodemonEventListener[K];
  } & {
    [K in keyof NodemonEventListener as 'once']: NodemonEventListener[K];
  };

declare const nodemon: Nodemon;

export = nodemon;
