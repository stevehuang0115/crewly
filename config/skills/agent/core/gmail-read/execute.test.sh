#!/bin/bash
# Tests for gmail-read — run with: bash execute.test.sh
# Spins up a python HTTP stub as the backend, asserts the request path the
# skill sends and the JSON it prints. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18802
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
MSG = {'id': 'm1', 'threadId': 't1', 'from': 'ann@example.com', 'to': 'owner@example.com', 'cc': '',
       'subject': 'Q3', 'date': 'D', 'messageId': '<abc@x>', 'snippet': 's', 'body': 'Hi\nthere', 'bodyType': 'text',
       'attachments': [{'filename': 'deck.pdf', 'mimeType': 'application/pdf', 'size': 12, 'attachmentId': 'A1'}],
       'labelIds': ['INBOX']}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        open(LOG, 'w').write(json.dumps({'method': 'GET', 'path': self.path}))
        if self.path.endswith('/missing'):
            self.send_response(404); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'google_error', 'message': 'Requested entity was not found.', 'hint': 'Google or Crewly Cloud failed; retry later.'}).encode()); return
        if self.path.endswith('/no-grant'):
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': MSG}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

WANT='{"id":"m1","threadId":"t1","from":"ann@example.com","to":"owner@example.com","cc":"","subject":"Q3","date":"D","messageId":"<abc@x>","body":"Hi\nthere","bodyType":"text","attachments":[{"filename":"deck.pdf","mimeType":"application/pdf","size":12,"attachmentId":"A1"}]}'

OUT=$(run --id m1)
check "flags: output (no snippet/labelIds)" "$OUT" "$WANT"
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/google/gmail/messages/m1"

OUT=$(run '{"id":"m 1"}')
check "json: output" "$OUT" "$WANT"
check "json: id is URL-encoded" "$(jq -r .path "$STUB_LOG")" "/api/google/gmail/messages/m%201"

OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --id missing 2>/dev/null); RC=$?
check "404: exit code" "$RC" "1"
check "404: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "google_error"
check "404: message" "$(printf '%s' "$OUT" | jq -r .message)" "Requested entity was not found."

OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --id no-grant 2>/dev/null)
check "409: hint is the connect URL" "$(printf '%s' "$OUT" | jq -r .hint)" "https://cloud/start?token=j"

check "missing id errors" "$(run_err)" "Missing required parameter: id (--id)"
check "unknown option errors" "$(run_err --bogus 1)" "Unknown option: --bogus"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
