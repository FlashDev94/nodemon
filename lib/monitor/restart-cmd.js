'use strict';

/**
 * One-shot restart command helpers.
 *
 * Typing `rs` restarts with the original command.
 * Typing `rs <args>` restarts once with those extra args appended; the next
 * restart always returns to the original command after that one run.
 *
 * Plain `rs` and non-restart stdin behavior are unchanged.
 */

var utils = require('../utils');

/**
 * Tokenize a shell-ish argument string, grouping single/double quoted values.
 * @param {string} string
 * @return {string[]}
 */
function tokenizeArgs(string) {
  var args = [];
  if (!string) {
    return args;
  }

  var parts = String(string).split(' ');
  var length = parts.length;
  var i = 0;
  var open = false;
  var grouped = '';
  var lead = '';

  for (; i < length; i++) {
    if (!parts[i] && !open) {
      continue;
    }
    lead = parts[i].substring(0, 1);
    if (!open && (lead === '"' || lead === "'")) {
      open = lead;
      grouped = parts[i].substring(1);
      if (grouped.slice(-1) === open && parts[i].length > 1) {
        args.push(grouped.slice(0, -1));
        open = false;
        grouped = '';
      }
    } else if (open && parts[i].slice(-1) === open) {
      open = false;
      grouped += (grouped.length ? ' ' : '') + parts[i].slice(0, -1);
      args.push(grouped);
      grouped = '';
    } else if (open) {
      grouped += (grouped.length ? ' ' : '') + parts[i];
    } else {
      args.push(parts[i]);
    }
  }

  if (open && grouped) {
    args.push(grouped);
  }

  return args.filter(function (a) {
    return a !== '';
  });
}

/**
 * Parse a stdin line for the restartable command (`rs` by default).
 * Returns null when the line is not a restart command (stdin still forwards).
 *
 * Matching mirrors historical nodemon: the typed token is lowercased, then
 * compared to `restartable` as configured (not lowercased). Default `rs`
 * still matches `RS` / `rs` the same as before.
 *
 * @param {string} line
 * @param {string|false} restartable
 * @return {null|{extraArgs:string[]}}
 */
function parseRestartLine(line, restartable) {
  if (restartable === false || restartable == null || restartable === '') {
    return null;
  }

  var trimmed = String(line == null ? '' : line).replace(/^\s+|\s+$/g, '');
  if (!trimmed) {
    return null;
  }

  var m = trimmed.match(/^(\S+)([\s\S]*)$/);
  if (!m) {
    return null;
  }

  // Lowercase only the input token (historical whole-line toLowerCase).
  if (m[1].toLowerCase() !== String(restartable)) {
    return null;
  }

  var rest = m[2].replace(/^\s+/, '');
  if (!rest) {
    return { extraArgs: [] };
  }

  return { extraArgs: tokenizeArgs(rest) };
}

/**
 * Snapshot the permanent (original) command after config load.
 * @param {{executable:string, args:string[]}} cmd
 * @return {{executable:string, args:string[]}}
 */
function snapshotCommandBase(cmd) {
  return {
    executable: cmd.executable,
    args: (cmd.args || []).slice(),
  };
}

/**
 * Build config.command for this run: original args plus any pending one-shot
 * extra args. Consumes one-shot args so the *next* materialize is original.
 *
 * @param {object} config  nodemon internal config
 * @return {{executable:string, args:string[]}}
 */
function materializeCommand(config) {
  var base =
    config.commandBase ||
    (config.command && config.command.raw) || { executable: 'node', args: [] };

  var args = (base.args || []).slice();
  var extra = config.oneShotArgs;

  if (extra && extra.length) {
    args = args.concat(extra);
  }

  config.oneShotArgs = null;

  var raw = {
    executable: base.executable,
    args: args,
  };

  config.command = {
    raw: raw,
    string: utils.stringify(raw.executable, raw.args),
  };

  return raw;
}

/**
 * Queue extra args for the next child start only.
 * Pass null/empty to clear (plain restart uses original command).
 *
 * @param {object} config
 * @param {string[]|null|undefined} args
 */
function setOneShotArgs(config, args) {
  if (args && args.length) {
    config.oneShotArgs = args.slice();
  } else {
    config.oneShotArgs = null;
  }
}

module.exports = {
  parseRestartLine: parseRestartLine,
  tokenizeArgs: tokenizeArgs,
  snapshotCommandBase: snapshotCommandBase,
  materializeCommand: materializeCommand,
  setOneShotArgs: setOneShotArgs,
};
