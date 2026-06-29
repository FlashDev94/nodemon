# Nodemon MCP mode

Opt-in only (`--mcp` / `"mcp": true`). When off, no MCP server starts.

## What to use when testing

| Goal | Use |
| --- | --- |
| Quick terminal test | **REST** `http://127.0.0.1:<port>/api/*` |
| Call same logic as MCP tools without an MCP client | `POST /api/tools/<toolName>` |
| MCP client with SSE support | `GET /mcp` + `POST /messages?sessionId=` |
| MCP client that spawns a process | `--mcp-stdio` |

## Tools

- `nodemon_status`
- `nodemon_watched_files` — body/args: `{ "limit": 50 }`
- `nodemon_restart_history` — `{ "limit": 20 }`
- `nodemon_logs` — `{ "limit": 50, "type": "status" }`
- `nodemon_config`
- `nodemon_restart`
- `nodemon_quit`

## Example (repo checkout)

```bash
node ./bin/nodemon.js --mcp --mcpPort 8765 --ext js test/fixtures/app.js
```

```bash
curl -s http://127.0.0.1:8765/api/tools
curl -s -X POST http://127.0.0.1:8765/api/tools/nodemon_status
curl -s -X POST http://127.0.0.1:8765/api/tools/nodemon_restart
```

Or: `bash scripts/mcp-smoke.sh 8765`
