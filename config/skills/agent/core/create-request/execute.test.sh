#!/bin/bash
# Co-located bash test for create-request skill.
# Spins up a tiny python HTTP stub to capture the outgoing body, then
# asserts that sourceConversationItemId is always present (synthesized
# when missing) — Issue #458 regression gate.
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
PORT=18789

# --- Start stub backend on a fixed test port ---
STUB_LOG="$(mktemp)"
export STUB_LOG
export STUB_PORT="${PORT}"

python3 -u <<'PY' >/tmp/create-request-stub.log 2>&1 &
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
        }
        with open(LOG_PATH, 'w') as f:
            f.write(json.dumps(log))
        self.send_response(201)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'id': 'req-stub-123'}}).encode('utf-8'))
    def log_message(self, *a, **k):
        pass

srv = HTTPServer(('127.0.0.1', PORT), H)
srv.serve_forever()
PY
STUB_PID=$!

cleanup() { kill "$STUB_PID" >/dev/null 2>&1 || true; rm -f "$STUB_LOG" || true; }
trap cleanup EXIT

# Wait until the port actually accepts a connection
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

# --- Test 1: Issue #458 — TL agent flow without --source-message-id ---
echo "test 1: agent-self synthesis when --source-message-id is omitted"
: > "$STUB_LOG"
OUT=$(run_skill \
  --title "Fix dogfood pipeline P0" \
  --description "Fix the pipeline regression that blocked decomposition" \
  --intent-level L1 \
  --intent-category debugging \
  2>&1 || true)
LOG=$(cat "$STUB_LOG" 2>/dev/null || echo '{}')
assert_contains "success echoed" "$OUT" '"success": true'
assert_contains "sourceConversationItemId synthesized" "$LOG" 'sourceConversationItemId'
assert_contains "synthesized id uses agent-self prefix" "$LOG" 'agent-self-crewly-product-sam-TEST-'
assert_contains "path targets /requests" "$LOG" '/requests'

# --- Test 2: --source-message-id provided is preserved ---
echo "test 2: explicit --source-message-id passes through unchanged"
: > "$STUB_LOG"
OUT=$(run_skill \
  --title "Inbound Slack request" \
  --description "Some inbound user message routing through orc" \
  --intent-level L2 \
  --intent-category code_change \
  --source-message-id "slack-D0AC7-1234567890.000001" \
  2>&1 || true)
LOG=$(cat "$STUB_LOG" 2>/dev/null || echo '{}')
assert_contains "explicit sourceConversationItemId preserved" "$LOG" 'slack-D0AC7-1234567890.000001'
if echo "$LOG" | grep -q 'agent-self-'; then
  FAIL=$((FAIL + 1))
  echo "  ✗ agent-self prefix wrongly added when explicit id present"
else
  PASS=$((PASS + 1))
  echo "  ✓ explicit id is not overwritten by agent-self synthesis"
fi

# --- Test 3: legacy JSON form without sourceMessageId still gets synthesis ---
echo "test 3: legacy JSON form falls back to agent-self synthesis"
: > "$STUB_LOG"
OUT=$(run_skill '{"title":"json form","description":"some description","intentLevel":"L1","intentCategory":"debugging"}' 2>&1 || true)
LOG=$(cat "$STUB_LOG" 2>/dev/null || echo '{}')
assert_contains "json-form synthesis works too" "$LOG" 'agent-self-crewly-product-sam-TEST-'

# --- Test 4: explicit empty-string --source-message-id triggers synthesis ---
echo "test 4: empty-string source-message-id treated as missing"
: > "$STUB_LOG"
OUT=$(run_skill \
  --title "Empty id test" \
  --description "Caller passed --source-message-id with an empty string" \
  --intent-level L1 \
  --intent-category debugging \
  --source-message-id "" \
  2>&1 || true)
LOG=$(cat "$STUB_LOG" 2>/dev/null || echo '{}')
assert_contains "empty-string id triggers synthesis" "$LOG" 'agent-self-crewly-product-sam-TEST-'

# --- Test 5: two back-to-back synthesis calls produce distinct ids ---
# Issue #458 review follow-up: the synthesis nonce ($RANDOM) must prevent
# per-second collisions so `findBySourceConversationItemId` doesn't false-
# positive on a second TL self-file in the same wall-clock second.
echo "test 5: rapid synthesis produces distinct ids (no per-second collision)"
: > "$STUB_LOG"
run_skill --title "First" --description "Description one" --intent-level L1 --intent-category debugging >/dev/null 2>&1 || true
ID_1=$(jq -r '.body | fromjson | .sourceConversationItemId' "$STUB_LOG" 2>/dev/null || echo '')
: > "$STUB_LOG"
run_skill --title "Second" --description "Description two" --intent-level L1 --intent-category debugging >/dev/null 2>&1 || true
ID_2=$(jq -r '.body | fromjson | .sourceConversationItemId' "$STUB_LOG" 2>/dev/null || echo '')
if [ -n "$ID_1" ] && [ -n "$ID_2" ] && [ "$ID_1" != "$ID_2" ]; then
  PASS=$((PASS + 1))
  echo "  ✓ two rapid syntheses produce distinct ids ($ID_1 vs $ID_2)"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ rapid syntheses collided or were empty: '$ID_1' '$ID_2'"
fi

echo
echo "========================================"
echo "create-request skill: PASS=$PASS  FAIL=$FAIL"
echo "========================================"
if [ "$FAIL" -gt 0 ]; then
  echo "--- stub server log ---"
  cat /tmp/create-request-stub.log 2>/dev/null | tail -40
  exit 1
fi
exit 0
