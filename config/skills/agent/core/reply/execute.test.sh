#!/bin/bash
# Co-located bash test for the reply skill: captures the outgoing request with
# a tiny python stub and checks the documented contract.
#
# Usage: bash execute.test.sh  (exit 0 on pass)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SCRIPT_DIR}/execute.sh"
PASS=0
FAIL=0
PORT=18791

STUB_LOG="$(mktemp)"
export STUB_LOG
export STUB_PORT="${PORT}"

python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG_PATH = os.environ['STUB_LOG']
PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(length).decode('utf-8') if length else ''
        with open(LOG_PATH, 'w') as f:
            f.write(json.dumps({'path': self.path, 'body': body, 'agentSession': self.headers.get('x-agent-session', '')}))
        self.send_response(201)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'messageId': 'm-1'}}).encode('utf-8'))
    def log_message(self, *a, **k):
        pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
cleanup() { kill "$STUB_PID" >/dev/null 2>&1 || true; wait "$STUB_PID" 2>/dev/null || true; rm -f "$STUB_LOG" || true; }
trap cleanup EXIT
for i in $(seq 1 30); do
  if curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/__probe__" 2>/dev/null; then break; fi
  sleep 0.1
done

check() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then PASS=$((PASS + 1)); echo "  ✓ $name"; else FAIL=$((FAIL + 1)); echo "  ✗ $name (wanted: $needle) in: $haystack"; fi
}
run_skill() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-team-ella-TEST" bash "$SKILL" "$@"; }

echo "test 1: positional text"
: > "$STUB_LOG"
OUT=$(run_skill "hello owner" 2>&1 </dev/null || true)
LOG=$(cat "$STUB_LOG")
check "posts to /api/chat/reply" "$LOG" '/api/chat/reply'
check "carries the text" "$LOG" 'hello owner'
check "names the agent" "$LOG" 'crewly-team-ella-TEST'
check "echoes success" "$OUT" '"success": *true'

echo "test 2: stdin"
: > "$STUB_LOG"
OUT=$(printf 'line one\nline two\n' | run_skill 2>&1 || true)
LOG=$(cat "$STUB_LOG")
check "stdin line one" "$LOG" 'line one'
check "stdin line two" "$LOG" 'line two'

echo "test 3: --none and --interim"
: > "$STUB_LOG"
run_skill --none </dev/null >/dev/null 2>&1 || true
check "none flag" "$(cat "$STUB_LOG")" 'none\\": true'
: > "$STUB_LOG"
run_skill --interim "plan first" </dev/null >/dev/null 2>&1 || true
check "interim flag" "$(cat "$STUB_LOG")" 'interim\\": true'

echo "test 4: explicit ids pass through"
: > "$STUB_LOG"
run_skill --conversation chan-9 --thread D0ABC:1790000000.000100 "x" </dev/null >/dev/null 2>&1 || true
LOG=$(cat "$STUB_LOG")
check "conversationId" "$LOG" 'chan-9'
check "thread" "$LOG" 'D0ABC:1790000000.000100'

echo "test 4b: --new-thread"
: > "$STUB_LOG"
run_skill --new-thread "Wiki link audit" "Found 3 broken links" </dev/null >/dev/null 2>&1 || true
LOG=$(cat "$STUB_LOG")
check "newThread title" "$LOG" 'newThread'
check "title text" "$LOG" 'Wiki link audit'
check "body text" "$LOG" 'Found 3 broken links'

echo "test 4d: Drive mode (--drive / --recap)"
: > "$STUB_LOG"
run_skill --drive drv_abc12345 --recap "Drive mode recap — you said X; next: nothing pending" </dev/null >/dev/null 2>&1 || true
LOG="$(cat "$STUB_LOG")"
check "drive session" "$LOG" 'drive\\": \\"drv_abc12345'
check "recap flag" "$LOG" 'recap\\": true'

echo "test 4c: references (--ticket / --to / --work-item / --decision)"
: > "$STUB_LOG"
run_skill --ticket TKT-187 --to msg-42 --work-item wi-7 --decision D-12 "preview: https://x" </dev/null >/dev/null 2>&1 || true
LOG=$(cat "$STUB_LOG")
check "ticket" "$LOG" 'ticket\\": \\"TKT-187'
check "to" "$LOG" 'to\\": \\"msg-42'
check "workItemId" "$LOG" 'workItemId\\": \\"wi-7'
check "decision" "$LOG" 'decision\\": \\"D-12'

echo "test 5: no text → error, nothing sent"
: > "$STUB_LOG"
if OUT=$(run_skill </dev/null 2>&1); then FAIL=$((FAIL + 1)); echo "  ✗ expected non-zero exit"; else PASS=$((PASS + 1)); echo "  ✓ non-zero exit"; fi
check "error explains" "$OUT" 'Reply text is required'

echo "reply skill: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
