#!/usr/bin/env bash
# Smoke-test nodemon MCP HTTP + tool endpoints (run from repo root)
set -euo pipefail
PORT="${1:-8765}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASE="http://127.0.0.1:${PORT}"
LOG="${TMPDIR:-/tmp}/nodemon-mcp-${PORT}.log"

echo "Starting: node ./bin/nodemon.js --mcp --mcpPort ${PORT} --ext js test/fixtures/app.js"
node ./bin/nodemon.js --mcp --mcpPort "$PORT" --ext js test/fixtures/app.js >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT

ok=0
for i in $(seq 1 50); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.2
done

if [ "$ok" != "1" ]; then
  echo "FAIL: MCP did not become ready on $BASE" >&2
  echo "--- nodemon log ---" >&2
  cat "$LOG" >&2 || true
  exit 1
fi

echo "=== GET /health ==="
curl -s "$BASE/health"; echo
echo "=== GET /api/tools ==="
curl -s "$BASE/api/tools"; echo
echo "=== POST /api/tools/nodemon_status ==="
curl -s -X POST "$BASE/api/tools/nodemon_status"; echo
echo "=== POST /api/tools/nodemon_last_crash ==="
curl -s -X POST "$BASE/api/tools/nodemon_last_crash"; echo
echo "=== GET /api/watched?limit=5 ==="
curl -s "$BASE/api/watched?limit=5"; echo
echo "=== POST /api/tools/nodemon_restart ==="
curl -s -X POST "$BASE/api/tools/nodemon_restart"; echo
sleep 1
echo "=== POST /api/tools/nodemon_restart_history ==="
curl -s -X POST "$BASE/api/tools/nodemon_restart_history" -H 'Content-Type: application/json' -d '{"limit":5}'; echo
echo "=== POST /api/tools/nodemon_logs ==="
curl -s -X POST "$BASE/api/tools/nodemon_logs" -H 'Content-Type: application/json' -d '{"limit":5}'; echo
echo "=== POST /api/tools/nodemon_config ==="
curl -s -X POST "$BASE/api/tools/nodemon_config"; echo
echo "OK — MCP smoke passed (nodemon pid $PID). Log: $LOG"
