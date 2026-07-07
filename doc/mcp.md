# Nodemon MCP mode

Opt-in only (`--mcp` / `"mcp": true` in `nodemon.json`). When off, no MCP
server starts and normal nodemon behavior is unchanged.

## Security (production defaults)

| Control | Default | Notes |
| --- | --- | --- |
| Bind host | `127.0.0.1` | Loopback only |
| Token | unset | Optional on loopback; **required** with remote bind |
| Non-loopback bind | refused | Needs `--mcpAllowRemote` **and** `--mcpToken` |
| CORS | none | No `Access-Control-Allow-Origin: *` (avoids browser CSRF) |
| Body size | 1MB max | Oversized POST → 413 |

When `mcpToken` is set, pass one of:

- `Authorization: Bearer <token>`
- header `X-Nodemon-Mcp-Token: <token>`
- query `?token=<token>` (prefer headers)

`GET /health` is always unauthenticated (liveness only).

SSE/stdio transports need the **optional** dependency
`@modelcontextprotocol/sdk` (Node **>= 18**). REST `/api/*` works without it.

```bash
# optional — only if you need MCP SSE or stdio
npm install @modelcontextprotocol/sdk
```

## What to use when testing

| Goal | Use |
| --- | --- |
| Quick terminal test | **REST** `http://127.0.0.1:<port>/api/*` |
| Call same logic as MCP tools without an MCP client | `POST /api/tools/<toolName>` |
| MCP client with SSE support | `GET /mcp` + `POST /messages?sessionId=` (+ token if set) |
| MCP client that spawns a process | `--mcp-stdio` |

## Tools

| Tool | Args | Purpose |
| --- | --- | --- |
| `nodemon_status` | — | Runtime status, pids, restart count, **lastCrash**, config summary |
| `nodemon_watched_files` | `{ "limit": 50 }` | Files currently tracked (updated on add/unlink) |
| `nodemon_restart_history` | `{ "limit": 20 }` | Recent restarts with reasons/files |
| `nodemon_last_crash` | — | Most recent crash (`null` if none) |
| `nodemon_logs` | `{ "limit": 50, "type": "status" }` | Recent nodemon log lines |
| `nodemon_config` | — | Active config summary |
| `nodemon_restart` | — | Safely restart the child (`type: api`, `trigger: mcp`) |
| `nodemon_quit` | — | Quit the monitor (response flushes first; server stops) |

## CLI

```bash
# HTTP + REST + optional MCP SSE (default when --mcp)
node ./bin/nodemon.js --mcp --mcpPort 8765 --mcpHost 127.0.0.1 --ext js app.js

# with token (recommended even on loopback in shared machines)
node ./bin/nodemon.js --mcp --mcpToken secret --ext js app.js
curl -s -H "Authorization: Bearer secret" http://127.0.0.1:8765/api/status

# remote bind (explicit, requires token)
node ./bin/nodemon.js --mcp --mcpHost 0.0.0.0 --mcpAllowRemote --mcpToken secret app.js

# stdio transport for MCP clients that spawn nodemon
node ./bin/nodemon.js --mcp-stdio --ext js app.js
```

Flags: `--mcp`, `--mcp-stdio`, `--mcpPort <n>`, `--mcpHost <host>`,
`--mcpTransport http|stdio`, `--mcpToken <secret>`, `--mcpAllowRemote`.

## Config (`nodemon.json`)

```json
{
  "mcp": true,
  "mcpPort": 8765,
  "mcpHost": "127.0.0.1",
  "mcpTransport": "http",
  "mcpToken": null,
  "mcpAllowRemote": false
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

## Lifecycle

On `quit` or `nodemon.reset()`, the HTTP server closes and MCP bus state is
cleared so ports are not leaked in programmatic / long-lived hosts.
