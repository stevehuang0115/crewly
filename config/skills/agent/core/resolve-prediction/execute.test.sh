#!/bin/bash
# Tests for resolve-prediction — run with: bash execute.test.sh
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

PORT=18794
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
        self.send_header_json = lambda code: (self.send_response(code), self.send_header('Content-Type', 'application/json'), self.end_headers())
        if '/pred-missing/' in self.path:
            self.send_header_json(404); self.wfile.write(b'{"success":false,"error":"Prediction pred-missing not found"}'); return
        if 'accurate' not in data and data.get('outcome') not in ('correct', 'wrong'):
            self.send_header_json(400); self.wfile.write(b'{"success":false,"error":"accurate (boolean) is required"}'); return
        acc = data.get('accurate', data.get('outcome') == 'correct')
        pred = {'id': 'pred-1-abc', 'prediction': 'x', 'confidence': 0.9, 'madeAt': '2026-09-18', 'outcome': data.get('outcome'), 'accurate': acc, 'resolvedAt': '2026-09-18'}
        self.send_header_json(200)
        self.wfile.write(json.dumps({'success': True, 'data': {'prediction': pred, 'calibrationScore': 0.82}}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

OUT=$(run --id pred-1-abc --outcome "merged Thursday" --accurate true)
check "flags: success + calibration" "$(printf '%s' "$OUT" | jq -c '{success, calibrationScore}')" '{"success":true,"calibrationScore":0.82}'
check "flags: prediction accurate" "$(printf '%s' "$OUT" | jq -r .prediction.accurate)" "true"
check "flags: path includes id" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-dev-1/self-improvement/predictions/pred-1-abc/resolve"
check "flags: body (accurate is boolean)" "$(jq -c .body "$STUB_LOG")" '{"outcome":"merged Thursday","accurate":true}'

run --id pred-1-abc --outcome wrong >/dev/null
check "verdict-only outcome omits accurate" "$(jq -c .body "$STUB_LOG")" '{"outcome":"wrong"}'

run '{"id":"pred-1-abc","outcome":"slipped","accurate":false,"sessionName":"crewly-qa-9"}' >/dev/null
check "json: body" "$(jq -c .body "$STUB_LOG")" '{"outcome":"slipped","accurate":false}'
check "json: explicit session in path" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-qa-9/self-improvement/predictions/pred-1-abc/resolve"

run '{"predictionId":"pred-1-abc","outcome":"correct"}' >/dev/null
check "json: accepts legacy predictionId key" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-dev-1/self-improvement/predictions/pred-1-abc/resolve"

OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" --id pred-missing --outcome correct 2>/dev/null); RC=$?
check "backend 404: exit code" "$RC" "1"
check "backend 404: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "Prediction pred-missing not found"

OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" --id pred-1-abc --outcome "took a while" 2>/dev/null); RC=$?
check "backend 400 (ambiguous outcome): reason" "$(printf '%s' "$OUT" | jq -r .reason)" "accurate (boolean) is required"

check "bad accurate value rejected locally" "$(run_err --session s --id p --outcome x --accurate maybe)" "accurate must be true or false (got: maybe)"
check "missing id errors" "$(run_err --session s --outcome x)" "Missing required parameter: id (--id)"
check "missing outcome errors" "$(run_err --session s --id p)" "Missing required parameter: outcome (--outcome)"
check "missing session errors" "$(run_err --id p --outcome x)" "Missing required parameter: sessionName (--session or CREWLY_SESSION_NAME)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
