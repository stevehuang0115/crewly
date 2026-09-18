#!/bin/bash
# Tests for record-prediction — run with: bash execute.test.sh
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

PORT=18793
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
        if data.get('resolveBy') == 'soon':
            self.send_response(400); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"success":false,"error":"resolveBy must be an ISO date string"}'); return
        pred = {'id': 'pred-1-abc', 'prediction': data.get('statement'), 'confidence': data.get('confidence'), 'madeAt': '2026-09-18'}
        if 'resolveBy' in data: pred['resolveBy'] = data['resolveBy']
        self.send_response(201); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'prediction': pred}}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

OUT=$(run --statement "PR lands today" --confidence 0.7 --resolve-by 2026-10-01)
check "flags: output id" "$(printf '%s' "$OUT" | jq -r .id)" "pred-1-abc"
check "flags: output success" "$(printf '%s' "$OUT" | jq -r .success)" "true"
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-dev-1/self-improvement/predictions"
check "flags: body (confidence is numeric, resolveBy present)" "$(jq -c .body "$STUB_LOG")" '{"statement":"PR lands today","confidence":0.7,"resolveBy":"2026-10-01"}'

run '{"statement":"no deadline","confidence":1,"sessionName":"crewly-qa-9"}' >/dev/null
check "json: body omits resolveBy when absent" "$(jq -c .body "$STUB_LOG")" '{"statement":"no deadline","confidence":1}'
check "json: explicit session in path" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-qa-9/self-improvement/predictions"

run '{"prediction":"legacy field name","confidence":"0.25"}' >/dev/null
check "json: accepts legacy 'prediction' key and string confidence" "$(jq -c .body "$STUB_LOG")" '{"statement":"legacy field name","confidence":0.25}'

OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" --statement x --confidence 0.5 --resolve-by soon 2>/dev/null); RC=$?
check "backend 400: exit code" "$RC" "1"
check "backend 400: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "resolveBy must be an ISO date string"

check "confidence > 1 rejected locally" "$(run_err --session s --statement x --confidence 1.5)" "confidence must be a number between 0 and 1 (got: 1.5)"
check "non-numeric confidence rejected locally" "$(run_err --session s --statement x --confidence abc)" "confidence must be a number between 0 and 1 (got: abc)"
check "missing statement errors" "$(run_err --session s --confidence 0.5)" "Missing required parameter: statement (--statement)"
check "missing confidence errors" "$(run_err --session s --statement x)" "Missing required parameter: confidence (--confidence)"
check "missing session errors" "$(run_err --statement x --confidence 0.5)" "Missing required parameter: sessionName (--session or CREWLY_SESSION_NAME)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
