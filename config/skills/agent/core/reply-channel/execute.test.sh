#!/bin/bash
# Co-located bash test for reply-channel skill.
# Runs a tiny python HTTP stub to capture the outgoing request, then
# asserts both the URL and the JSON body match the documented contract.
#
# Usage: bash execute.test.sh  (exit 0 on pass)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SCRIPT_DIR}/execute.sh"

if [ ! -x "$SKILL" ]; then
  echo "FAIL: skill not executable at $SKILL" >&2
  exit 1
fi

PASS=0
FAIL=0
PORT=18787

# --- Start stub backend on a fixed test port ---
# Env MUST be exported BEFORE the python fork so the child inherits.
STUB_LOG="$(mktemp)"
export STUB_LOG
export STUB_PORT="${PORT}"

python3 -u <<'PY' >/tmp/reply-channel-stub.log 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os, sys

LOG_PATH = os.environ['STUB_LOG']
PORT = int(os.environ['STUB_PORT'])

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(length).decode('utf-8') if length else ''
        log = {
            'path': self.path,
            'body': body,
            'agentSession': self.headers.get('x-agent-session', ''),
            'contentType': self.headers.get('content-type', ''),
        }
        with open(LOG_PATH, 'w') as f:
            f.write(json.dumps(log))
        self.send_response(201)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'id': 'm-stub-123', 'channelId': 'chan-xyz'}}).encode('utf-8'))
    def log_message(self, *a, **k):
        pass

srv = HTTPServer(('127.0.0.1', PORT), H)
srv.serve_forever()
PY
STUB_PID=$!

cleanup() { kill "$STUB_PID" >/dev/null 2>&1 || true; rm -f "$STUB_LOG" || true; }
trap cleanup EXIT

# Wait until the port actually accepts a connection (up to ~3s). This is
# more reliable than a fixed sleep on slower boxes.
for i in $(seq 1 30); do
  if curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/__probe__" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q -- "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $name (wanted: $needle)"
    echo "    in: $haystack"
  fi
}

run_skill() {
  CREWLY_API_URL="http://127.0.0.1:${PORT}" \
  CREWLY_SESSION_NAME="crewly-product-sam-TEST" \
  bash "$SKILL" "$@"
}

# --- Test 1: flag form, single-line content ---
echo "test 1: --channel + --content"
: > "$STUB_LOG"
OUT=$(run_skill --channel chan-xyz --content "hello from agent" 2>&1 || true)
LOG=$(cat "$STUB_LOG" 2>/dev/null || echo '{}')
assert_contains "success echoed" "$OUT" '"success":true'
assert_contains "messageId echoed" "$OUT" 'm-stub-123'
assert_contains "path targets /api/chat/channels/:id/messages" "$LOG" '/api/chat/channels/chan-xyz/messages'
assert_contains "body carries content" "$LOG" 'hello from agent'
assert_contains "body contentType markdown" "$LOG" 'markdown'
assert_contains "X-Agent-Session header present" "$LOG" 'crewly-product-sam-TEST'

# --- Test 2: JSON argument form ---
echo "test 2: JSON payload"
: > "$STUB_LOG"
OUT=$(run_skill '{"channelId":"chan-xyz","content":"via json","clientMessageId":"cmid-123"}' 2>&1 || true)
LOG=$(cat "$STUB_LOG" 2>/dev/null || echo '{}')
assert_contains "success echoed (json form)" "$OUT" '"success":true'
assert_contains "body has content (json form)" "$LOG" 'via json'
assert_contains "body includes clientMessageId" "$LOG" 'cmid-123'

# --- Test 3: multiline content via stdin ---
echo "test 3: stdin pipe"
: > "$STUB_LOG"
OUT=$(printf 'line one\nline two\n' | run_skill --channel chan-xyz 2>&1 || true)
LOG=$(cat "$STUB_LOG" 2>/dev/null || echo '{}')
assert_contains "success echoed (stdin form)" "$OUT" '"success":true'
assert_contains "body contains line one" "$LOG" 'line one'
assert_contains "body contains line two" "$LOG" 'line two'

# --- Test 4: missing --channel errors out ---
echo "test 4: missing channel"
if OUT=$(run_skill --content "no channel" 2>&1); then
  FAIL=$((FAIL + 1))
  echo "  ✗ expected non-zero exit when --channel missing"
else
  PASS=$((PASS + 1))
  echo "  ✓ non-zero exit when --channel missing"
fi
assert_contains "error surfaces" "$OUT" '--channel is required'

# --- Test 5: missing content errors out ---
echo "test 5: missing content"
if OUT=$(run_skill --channel chan-xyz 2>&1 </dev/null); then
  FAIL=$((FAIL + 1))
  echo "  ✗ expected non-zero exit when --content missing"
else
  PASS=$((PASS + 1))
  echo "  ✓ non-zero exit when --content missing"
fi
assert_contains "content-required error surfaces" "$OUT" '--content is required'

echo
echo "========================================"
echo "reply-channel skill: PASS=$PASS  FAIL=$FAIL"
echo "========================================"
if [ "$FAIL" -gt 0 ]; then
  echo "--- stub server log ---"
  cat /tmp/reply-channel-stub.log 2>/dev/null | tail -40
  exit 1
fi
exit 0
