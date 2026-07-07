# Nodemon MCP mode

Opt-in only (`--mcp` / `"mcp": true` in `nodemon.json`). When off, no MCP
server starts and normal nodemon behavior is unchanged.

## What to use when testing

| Goal | Use |
| --- | --- |
| Quick terminal test | **REST** `http://127.0.0.1:<port>/api/*` |
| Call same logic as MCP tools without an MCP client | `POST /api/tools/<toolName>` |
| MCP client with SSE support | `GET /mcp` + `POST /messages?sessionId=` |
| MCP client that spawns a process | `--mcp-stdio` |

## Tools

| Tool | Args | Purpose |
| --- | --- | --- |
| `nodemon_status` | — | Runtime status, pids, restart count, **lastCrash**, config summary |
| `nodemon_watched_files` | `{ "limit": 50 }` | Files currently tracked by the watcher |
| `nodemon_restart_history` | `{ "limit": 20 }` | Recent restarts with reasons/files |
| `nodemon_last_crash` | — | Most recent crash (`null` if none) |
| `nodemon_logs` | `{ "limit": 50, "type": "status" }` | Recent nodemon log lines |
| `nodemon_config` | — | Active config summary |
| `nodemon_restart` | — | Safely restart the child (same as `rs` / API) |
| `nodemon_quit` | — | Quit the monitor (response flushes first) |

## CLI

```bash
# HTTP + REST + optional MCP SSE (default when --mcp)
node ./bin/nodemon.js --mcp --mcpPort 8765 --mcpHost 127.0.0.1 --ext js app.js

# stdio transport for MCP clients that spawn nodemon
node ./bin/nodemon.js --mcp-stdio --ext js app.js
```

Flags: `--mcp`, `--mcp-stdio`, `--mcpPort <n>`, `--mcpHost <host>`,
`--mcpTransport http|stdio`.

## Config (`nodemon.json`)

```json
{
  "mcp": true,
  "mcpPort": 8765,
  "mcpHost": "127.0.0.1",
  "mcpTransport": "http"
}
```

## Example (repo checkout)

```bash
node ./bin/nodemon.js --mcp --mcpPort 8765 --ext js test/fixtures/app.js
```

```bash
curl -s http://127.0.0.1:8765/api/tools
curl -s -X POST http://127.0.0.1:8765/api/tools/nodemon_status
curl -s -X POST http://127.0.0.1:8765/api/tools/nodemon_last_crash
curl -s -X POST http://127.0.0.1:8765/api/tools/nodemon_restart
```

Or: `bash scripts/mcp-smoke.sh 8765`
