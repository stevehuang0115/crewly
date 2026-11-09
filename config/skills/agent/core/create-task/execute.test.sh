#!/bin/bash
# Tests for create-task carrying the owner place it is given (--thread / --conversation)
# and saying so when it is given none (message-routing audit 2026-10-18) — run with: bash execute.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi
}

PORT=18856
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
STUB_BODIES="$(mktemp)"; export STUB_BODIES
STUB_RUNNING="$(mktemp)"; export STUB_RUNNING
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def note(self, body=''):
        open(LOG, 'a').write(self.command + ' ' + self.path + '\n')
        if body:
            try: body = json.dumps(json.loads(body), separators=(',', ':'))
            except Exception: body = body.replace('\n', ' ')
            open(os.environ['STUB_BODIES'], 'a').write(self.path + ' ' + body + '\n')
    def do_GET(self):
        self.note()
        ids = [l.strip() for l in open(os.environ['STUB_RUNNING']) if l.strip()]
        return self.reply(200, {'workItems': [{'id': i} for i in ids]})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode()
        self.note(body)
        return self.reply(200, {'success': True})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG" "$STUB_BODIES" "$STUB_RUNNING"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=dev-1 CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$1" 2>&1; echo "exit=$?"; }
reset() { : > "$STUB_LOG"; : > "$STUB_BODIES"; }

: > "$STUB_RUNNING"

reset
OUT=$(run '{"projectPath":"/tmp/p","task":"Write the report","sessionName":"dev-1","thread":"C0A:1.2"}')
check "--thread: stored as metadata.ownerThread" "$(grep '/task-pool/add' "$STUB_BODIES" | grep -c '"ownerThread":"C0A:1.2"')" "1"
check "--thread: no note" "$(printf '%s' "$OUT" | grep -c 'answers no owner thread')" "0"

reset
CREWLY_SESSION_NAME=dev-1 CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --project-path /tmp/p --task "Write it" --session dev-1 --conversation room-1 >/dev/null 2>&1
check "--conversation flag: stored as metadata.ownerConversation" "$(grep '/task-pool/add' "$STUB_BODIES" | grep -c '"ownerConversation":"room-1"')" "1"

reset
OUT=$(run '{"projectPath":"/tmp/p","task":"Write the report","sessionName":"dev-1"}')
check "no owner place: still created" "$(grep -c 'POST /api/task-pool/add' "$STUB_LOG")" "1"
check "no owner place: says it answers no owner thread" "$(printf '%s' "$OUT" | grep -c 'answers no owner thread')" "1"
check "no owner place: no owner fields sent" "$(grep '/task-pool/add' "$STUB_BODIES" | grep -c 'ownerThread\|ownerConversation')" "0"

echo "create-task: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
