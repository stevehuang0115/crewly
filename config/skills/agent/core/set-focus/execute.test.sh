#!/bin/bash
# Tests for set-focus — run with: bash execute.test.sh
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

PORT=18791
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': json.loads(body or '{}')}))
        items = json.loads(body).get('items', [])
        if '__reject__' in items:
            self.send_response(400); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"success":false,"error":"items must be an array of non-empty strings"}'); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'focus': items, 'suppressed': ['old']}}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

# --- flags ---
OUT=$(run --item "ship v2" --item "flaky CI")
check "flags: output" "$OUT" '{"success":true,"focus":["ship v2","flaky CI"],"suppressed":["old"]}'
check "flags: path uses CREWLY_SESSION_NAME" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-dev-1/self-improvement/attention/focus"
check "flags: body" "$(jq -c .body "$STUB_LOG")" '{"items":["ship v2","flaky CI"]}'

# --- legacy JSON with explicit session ---
OUT=$(run '{"items":["a"],"sessionName":"crewly-qa-9"}')
check "json: output" "$OUT" '{"success":true,"focus":["a"],"suppressed":["old"]}'
check "json: explicit session in path" "$(jq -r .path "$STUB_LOG")" "/api/agents/crewly-qa-9/self-improvement/attention/focus"

# --- json string coerced to array ---
run '{"items":"solo"}' >/dev/null
check "json: string items coerced to array" "$(jq -c .body "$STUB_LOG")" '{"items":["solo"]}'

# --- backend error surfaces as success:false and exit 1 ---
OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME="crewly-dev-1" bash "$EXEC" --item __reject__ 2>/dev/null); RC=$?
check "backend 400: exit code" "$RC" "1"
check "backend 400: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "items must be an array of non-empty strings"

# --- validation ---
check "missing items errors" "$(run_err --session s1)" "Missing required parameter: items (--item)"
check "missing session errors" "$(run_err --item x)" "Missing required parameter: sessionName (--session or CREWLY_SESSION_NAME)"
check "unknown option errors" "$(run_err --bogus 1)" "Unknown option: --bogus"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
