'use strict';
/*global describe, it */
var assert = require('assert');
var cli = require('../../lib/cli');

describe('nodemon MCP CLI flags', function () {
  it('parses --mcp with default http transport', function () {
    var s = cli.parse('node nodemon --mcp test/fixtures/app.js');
    assert.strictEqual(s.mcp, true);
    assert.strictEqual(s.mcpTransport, 'http');
  });

  it('parses --mcp-stdio', function () {
    var s = cli.parse('node nodemon --mcp-stdio test/fixtures/app.js');
    assert.strictEqual(s.mcp, true);
    assert.strictEqual(s.mcpTransport, 'stdio');
  });

  it('parses --mcpPort and --mcpHost', function () {
    var s = cli.parse(
      'node nodemon --mcp --mcpPort 9999 --mcpHost 0.0.0.0 test/fixtures/app.js'
    );
    assert.strictEqual(s.mcp, true);
    assert.strictEqual(s.mcpPort, 9999);
    assert.strictEqual(s.mcpHost, '0.0.0.0');
  });

  it('parses --mcpToken and --mcpAllowRemote', function () {
    var s = cli.parse(
      'node nodemon --mcpToken secret --mcpAllowRemote test/fixtures/app.js'
    );
    assert.strictEqual(s.mcp, true);
    assert.strictEqual(s.mcpToken, 'secret');
    assert.strictEqual(s.mcpAllowRemote, true);
  });

  it('does not enable mcp when flag absent', function () {
    var s = cli.parse('node nodemon test/fixtures/app.js');
    assert.strictEqual(s.mcp, undefined);
  });
});
