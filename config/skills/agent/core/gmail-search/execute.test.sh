#!/bin/bash
# Tests for gmail-search — run with: bash execute.test.sh
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

PORT=18801
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
HIT = {'id': 'm1', 'threadId': 't1', 'from': 'Ann <ann@example.com>', 'to': 'owner@example.com',
       'subject': 'Q3 numbers', 'date': 'D', 'snippet': 'hi', 'labelIds': ['INBOX']}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        open(LOG, 'w').write(json.dumps({'method': 'GET', 'path': self.path}))
        qs = parse_qs(urlparse(self.path).query)
        q = qs.get('q', [''])[0]
        if q == 'no-grant':
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant',
                                         'hint': 'https://api.crewlyai.com/api/cloud/google/workspace/start?token=j'}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'query': q, 'count': 1, 'messages': [HIT]}}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

WANT='{"query":"is:unread from:ann","count":1,"messages":[{"id":"m1","threadId":"t1","from":"Ann <ann@example.com>","to":"owner@example.com","subject":"Q3 numbers","date":"D","snippet":"hi"}]}'

# --- flags ---
OUT=$(run --query "is:unread from:ann" --max 5)
check "flags: output drops labelIds" "$OUT" "$WANT"
check "flags: path is URL-encoded with max" "$(jq -r .path "$STUB_LOG")" "/api/google/gmail/search?q=is%3Aunread%20from%3Aann&max=5"

# --- JSON input ---
OUT=$(run '{"query":"is:unread from:ann"}')
check "json: output" "$OUT" "$WANT"
check "json: no max when absent" "$(jq -r .path "$STUB_LOG")" "/api/google/gmail/search?q=is%3Aunread%20from%3Aann"

# --- not connected → success:false + hint, exit 1 ---
OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --query no-grant 2>/dev/null); RC=$?
check "409: exit code" "$RC" "1"
check "409: reason + hint" "$OUT" '{"success":false,"reason":"not_connected","hint":"https://api.crewlyai.com/api/cloud/google/workspace/start?token=j","message":"no grant"}'

# --- validation ---
check "missing query errors" "$(run_err --max 3)" "Missing required parameter: query (--query)"
check "unknown option errors" "$(run_err --bogus 1)" "Unknown option: --bogus"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
