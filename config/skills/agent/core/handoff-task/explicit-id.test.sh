#!/bin/bash
# Tests for handoff-task naming its WorkItem and never guessing among several
# running ones (message-routing audit 2026-10-18) — run with: bash explicit-id.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi
}

PORT=18855
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

# Several running items and no id: refused, nothing handed over.
printf 'wi-a\nwi-b\n' > "$STUB_RUNNING"; reset
OUT=$(run '{"sessionName":"dev-1","to":"dev-2","reason":"swap"}')
check "two running, no id: refused" "$(printf '%s' "$OUT" | grep -c 'exit=1')" "1"
check "two running, no id: lists both ids" "$(printf '%s' "$OUT" | grep -c 'wi-a wi-b')" "1"
check "two running, no id: nothing delivered" "$(grep -c '/terminal/' "$STUB_LOG")" "0"

# An explicit id: the hand-over text carries it and its route; the notice names it.
reset
run '{"sessionName":"dev-1","to":"dev-2","reason":"swap","workItemId":"wi-b"}' >/dev/null
check "explicit id: hand-over names the WorkItem and its route" \
  "$(grep '/terminal/dev-2' "$STUB_BODIES" | grep -c 'WorkItem: wi-b {route: work-item wi-b}')" "1"
check "explicit id: [HANDOFF] notice carries the workItemId" \
  "$(grep '/chat/agent-response' "$STUB_BODIES" | grep -c '"workItemId":"wi-b"')" "1"

# One running item, no id: that one is used.
printf 'wi-only\n' > "$STUB_RUNNING"; reset
run '{"sessionName":"dev-1","to":"dev-2","reason":"swap"}' >/dev/null
check "one running, no id: hands over that one" "$(grep -c 'POST /api/task-pool/items/wi-only/handoff' "$STUB_LOG")" "1"

echo "handoff-task: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
