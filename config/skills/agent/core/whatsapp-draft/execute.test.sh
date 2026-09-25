#!/bin/bash
# Tests for whatsapp-draft — run with: bash execute.test.sh </dev/null
# Spins up a python HTTP stub as the backend, asserts the request body the
# skill sends and the JSON it prints. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18843
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def reply(self, code, body):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        open(LOG, 'w').write(json.dumps({'method': 'POST', 'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
        if body.get('chatId') == 'unknown@s.whatsapp.net':
            return self.reply(404, {'success': False, 'code': 'chat_not_found', 'error': 'Unknown chat: unknown@s.whatsapp.net'})
        self.reply(201, {'success': True, 'data': {'id': 'd-1', 'code': 'W12', 'seq': 12, 'chatId': body['chatId'], 'text': body['text'],
                                                   'status': 'pending', 'recipient': 'Ann', 'instruction': 'server says'}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
TMP_TEXT="$(mktemp)"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG" "$TMP_TEXT"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

OUT=$(run --chat 491@s.whatsapp.net --text 'Yes, 8 works — see you "there"')
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/drafts"
check "flags: body" "$(jq -c .body "$STUB_LOG")" '{"chatId":"491@s.whatsapp.net","text":"Yes, 8 works — see you \"there\""}'
check "flags: agent header" "$(jq -r .agent "$STUB_LOG")" "test-agent"
check "output: not sent" "$(printf '%s' "$OUT" | jq -r .sent)" "false"
check "output: draft" "$(printf '%s' "$OUT" | jq -c .draft)" '{"id":"d-1","code":"W12","recipient":"Ann","chatId":"491@s.whatsapp.net","text":"Yes, 8 works — see you \"there\""}'
NEXT=$(printf '%s' "$OUT" | jq -r .nextStep)
[[ "$NEXT" == *"NOT SENT"* && "$NEXT" == *"Ann"* && "$NEXT" == *"「发 W12」"* ]] && OK=yes || OK=no
check "output: nextStep tells the agent to ask the owner for 「发 W12」" "$OK" "yes"

printf 'line one\nline two' > "$TMP_TEXT"
run --chat 491@s.whatsapp.net --text-file "$TMP_TEXT" >/dev/null
check "text-file: body text" "$(jq -r .body.text "$STUB_LOG")" "$(printf 'line one\nline two')"

run '{"chatId":"491@s.whatsapp.net","text":"json hi"}' >/dev/null
check "json: body" "$(jq -c .body "$STUB_LOG")" '{"chatId":"491@s.whatsapp.net","text":"json hi"}'

OUT=$(CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --chat unknown@s.whatsapp.net --text hi 2>/dev/null); RC=$?
check "404: exit code" "$RC" "1"
check "404: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "chat_not_found"

check "missing chat" "$(run_err --text hi)" "Missing required parameter: chat (--chat)"
check "missing text" "$(run_err --chat 491@s.whatsapp.net)" "Missing required parameter: text (--text or --text-file)"
check "missing text file" "$(run_err --chat x --text-file /nonexistent/file)" "text file not found: /nonexistent/file"
check "unknown option errors" "$(run_err --send)" "Unknown option: --send"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
