'use strict';

var utils = require('../utils');
var config = require('../config');
var bus = utils.bus;

/**
 * Human-readable restart reason for logs.
 * @param {{type:string, files?:string[], trigger?:string, signal?:string, args?:string[]}} reason
 * @return {string}
 */
function formatRestartReason(reason) {
  if (!reason || !reason.type) {
    return 'unknown';
  }

  if (reason.type === 'watch') {
    var n = (reason.files && reason.files.length) || 0;
    return 'file change (' + n + ' file' + (n === 1 ? '' : 's') + ')';
  }

  if (reason.type === 'manual') {
    var manual = 'manual (' + (reason.trigger || 'rs') + ')';
    if (reason.args && reason.args.length) {
      return manual + ' with args: ' + reason.args.join(' ');
    }
    return manual;
  }

  if (reason.type === 'api') {
    if (reason.args && reason.args.length) {
      return 'api (nodemon.restart) with args: ' + reason.args.join(' ');
    }
    return 'api (nodemon.restart)';
  }

  if (reason.type === 'signal') {
    return 'signal (' + (reason.signal || 'unknown') + ')';
  }

  return String(reason.type);
}

/**
 * Emit the restart event with an optional reason as the second argument.
 * Existing listeners that only use `files` keep working.
 *
 * @param {string[]|undefined} files
 * @param {{type:string, files?:string[], trigger?:string, signal?:string, args?:string[]}} reason
 */
function emitRestart(files, reason) {
  reason = reason || { type: 'unknown' };

  // Attach files on the reason object for convenience (copy to avoid mutation).
  if (files && files.length && !reason.files) {
    reason = {
      type: reason.type,
      files: files,
      trigger: reason.trigger,
      signal: reason.signal,
      args: reason.args,
    };
  }

  var message = 'restart reason: ' + formatRestartReason(reason);

  // Opt-in status line; otherwise detail (visible with --verbose only).
  if (config.options && config.options.restartReason) {
    utils.log.status(message);
  } else {
    utils.log.detail(message);
  }

  bus.emit('restart', files, reason);
}

module.exports = {
  emitRestart: emitRestart,
  formatRestartReason: formatRestartReason,
};
