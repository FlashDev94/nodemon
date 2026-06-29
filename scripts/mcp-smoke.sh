#!/usr/bin/env bash
# Smoke-test nodemon MCP HTTP API (run from repo root)
set -euo pipefail
PORT="${1:-8765}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Starting nodemon --mcp on port $PORT ..."
node ./bin/nodemon.js --mcp --mcpPort "$PORT" --ext js test/fixtures/app.js >/tmp/nodemon-mcp.log 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
    break
  fi
  sleep 0.2
done

echo "=== /api/status ==="
curl -s "http://127.0.0.1:${PORT}/api/status"
echo
echo "=== /api/watched ==="
curl -s "http://127.0.0.1:${PORT}/api/watched?limit=5"
echo
echo "=== POST /api/restart ==="
curl -s -X POST "http://127.0.0.1:${PORT}/api/restart"
echo
sleep 1
echo "=== /api/history ==="
curl -s "http://127.0.0.1:${PORT}/api/history"
echo
echo "=== /api/logs (tail) ==="
curl -s "http://127.0.0.1:${PORT}/api/logs?limit=5"
echo
echo "OK — MCP smoke finished (nodemon pid $PID)"
