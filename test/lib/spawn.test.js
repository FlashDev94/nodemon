'use strict';
/*global describe, it */
var assert = require('assert');
var spawnCommand = require('../../lib/spawn');

describe('spawnCommand', function () {
  it('spawns a simple command without throwing', function (done) {
    var config = {
      required: false,
      options: {
        stdout: true,
        execOptions: { env: {} },
      },
    };
    // should not throw; process exits quickly
    assert.doesNotThrow(function () {
      spawnCommand('true', config, ['file.js']);
    });
    setTimeout(done, 50);
  });

  it('accepts command as an array', function (done) {
    var config = {
      required: false,
      options: {
        stdout: true,
        execOptions: { env: {} },
      },
    };
    assert.doesNotThrow(function () {
      spawnCommand(['echo', 'ok'], config, ['file.js']);
    });
    setTimeout(done, 50);
  });

  it('wires stdout/stderr when required and stdout is false', function (done) {
    var config = {
      required: true,
      options: {
        stdout: false,
        execOptions: { env: {} },
      },
    };
    assert.doesNotThrow(function () {
      spawnCommand('echo hello', config, ['file.js']);
    });
    setTimeout(done, 50);
  });
});
