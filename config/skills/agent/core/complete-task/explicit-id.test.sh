#!/bin/bash
# Tests for complete-task never swapping a named id for the running item (#1134) — run with: bash explicit-id.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi
}

PORT=18854
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
STUB_RUNNING="$(mktemp)"; export STUB_RUNNING
echo 'wi-running' > "$STUB_RUNNING"
: > "$STUB_LOG"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def note(self):
        open(LOG, 'a').write(self.command + ' ' + self.path + '\n')
    def do_GET(self):
        self.note()
        ids = [l.strip() for l in open(os.environ['STUB_RUNNING']) if l.strip()]
        return self.reply(200, {'workItems': [{'id': i} for i in ids]})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); self.rfile.read(n)
        self.note()
        return self.reply(200, {'success': True})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG" "$STUB_RUNNING"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=dev-1 CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$1" 2>&1; echo "exit=$?"; }

: > "$STUB_LOG"
OUT=$(run '{"taskId":"wi-other","sessionName":"dev-1","summary":"done"}')
check "taskId without workItemId: refused" "$(printf '%s' "$OUT" | grep -c 'exit=1')" "1"
check "taskId without workItemId: names the problem" "$(printf '%s' "$OUT" | grep -c "does not guess")" "1"
check "taskId without workItemId: nothing sent" "$(grep -vc heartbeat "$STUB_LOG")" "0"

: > "$STUB_LOG"
run '{"workItemId":"wi-given","sessionName":"dev-1","summary":"done"}' >/dev/null
check "explicit workItemId: completes exactly that one" "$(grep -v heartbeat "$STUB_LOG")" "POST /api/task-pool/complete/wi-given"

: > "$STUB_LOG"
run '{"sessionName":"dev-1","summary":"done"}' >/dev/null
check "no id at all: running-item lookup still works" "$(tail -1 "$STUB_LOG")" "POST /api/task-pool/complete/wi-running"

# Several running items: no `[0]` pick (message-routing audit 2026-10-18).
printf 'wi-a\nwi-b\n' > "$STUB_RUNNING"
: > "$STUB_LOG"
OUT=$(run '{"sessionName":"dev-1","summary":"done"}')
check "two running, no id: refused" "$(printf '%s' "$OUT" | grep -c 'exit=1')" "1"
check "two running, no id: lists both ids" "$(printf '%s' "$OUT" | grep -c 'wi-a wi-b')" "1"
check "two running, no id: nothing completed" "$(grep -c 'POST /api/task-pool/complete' "$STUB_LOG")" "0"

echo "complete-task: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
