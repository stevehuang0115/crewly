#!/bin/bash
# Tests for ask-owner — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts the calls and the output.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18853
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_GET(self):
        return self.reply(200, {'success': True})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = json.loads(self.rfile.read(n).decode() or '{}')
        open(LOG, 'w').write(json.dumps({'method': self.command, 'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
        if self.path.endswith('/cancel'):
            return self.reply(200, {'success': True, 'data': {'id': 'D-7', 'status': 'cancelled'}})
        if len(body.get('options', [])) < 2:
            return self.reply(400, {'success': False, 'error': 'options are required: give the owner 2–3 concrete choices'})
        return self.reply(201, {'success': True, 'data': {'id': 'D-7', 'asker': 'dev-ann', 'status': 'open', 'deadline': 'x', 'card': {'slackChannelId': 'C1'}}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=dev-ann CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=dev-ann CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }
last() { jq -r "$1" "$STUB_LOG"; }

OUT=$(run --question "Send the partner email on Monday?" --option "Send Monday — after review" --option "Hold" --default Hold --ticket APP-12 --project p1 --sensitive email)
check "ask: path" "$(last .path)" "/api/decisions"
check "ask: agent header" "$(last .agent)" "dev-ann"
check "ask: body" "$(last '.body | tostring')" '{"question":"Send the partner email on Monday?","options":["Send Monday — after review","Hold"],"default":"Hold","sensitive":"email","ticket":"APP-12","project":"p1"}'
check "ask: output" "$(printf '%s' "$OUT" | jq -c '.decision')" '{"id":"D-7","asker":"dev-ann","status":"open","deadline":"x","posted":true,"postError":null}'

run '{"question":"Blue or green for the logo?","options":["Blue","Green"],"default":"wait"}' >/dev/null
check "ask json: body" "$(last '.body | tostring')" '{"question":"Blue or green for the logo?","options":["Blue","Green"],"default":"wait"}'

check "ask: server error reaches the agent" "$(run_err --question "Thoughts on this one?" --option "A" | grep -c 'options are required')" "1"
check "ask: missing question" "$(run_err --option A --option B | grep -c 'question')" "1"

OUT=$(run --cancel D-7)
check "cancel: path" "$(last .path)" "/api/decisions/D-7/cancel"
check "cancel: output" "$(printf '%s' "$OUT" | jq -c '.decision')" '{"id":"D-7","status":"cancelled"}'

echo "ask-owner: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
