#!/bin/bash
# Tests for suppress-noise — run with: bash execute.test.sh
# Spins up a python HTTP stub as the backend, asserts the request path/body
# the skill sends and the JSON it prints. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18792
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        data = json.loads(body or '{}')
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': data}))
        if data.get('item') == '__reject__':
            self.send_response(400); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"success":false,"error":"item must be a non-empty string"}'); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'focus': ['keep'], 'suppressed': [data.get('item')]}}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

OUT=$(run --item "legacy webhooks")
check "flags: output" "$OUT" '{"success":true,"focus":["keep"],"suppressed":["legacy webhooks"]}'
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-dev-1/self-improvement/attention/suppress"
check "flags: body" "$(jq -c .body "$STUB_LOG")" '{"item":"legacy webhooks"}'

OUT=$(run '{"item":"noise (with) \"quotes\"","sessionName":"crewly-qa-9"}')
check "json: special characters survive" "$(jq -r .body.item "$STUB_LOG")" 'noise (with) "quotes"'
check "json: explicit session in path" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-qa-9/self-improvement/attention/suppress"

OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" --item __reject__ 2>/dev/null); RC=$?
check "backend 400: exit code" "$RC" "1"
check "backend 400: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "item must be a non-empty string"

check "missing item errors" "$(run_err --session s1)" "Missing required parameter: item (--item)"
check "missing session errors" "$(run_err --item x)" "Missing required parameter: sessionName (--session or CREWLY_SESSION_NAME)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
