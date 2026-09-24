#!/bin/bash
# Tests for ticket-check — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts the calls and the output.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18831
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
BOARD = {'tkt': 'TKT-012', 'title': 'CSV export', 'column': 'in_progress',
         'acceptance': [{'text': 'has a header row', 'source': 'reject', 'check': 'judgment'},
                        {'text': 'tests pass', 'source': 'decompose', 'check': 'auto'}]}
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_GET(self):
        if self.path == '/api/tickets/TKT-012':
            return self.reply(200, {'success': True, 'data': {'ticket': {'id': 'tid-12'}, 'board': BOARD}})
        return self.reply(404, {'success': False, 'error': 'Ticket not found'})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = json.loads(self.rfile.read(n).decode() or '{}')
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
        acc = [dict(a) for a in BOARD['acceptance']]
        acc[body['index']].update({'selfCheck': body['result']})
        return self.reply(200, {'success': True, 'data': {'acceptance': acc}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=ella CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=ella CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

# --- list mode numbers the criteria ---
OUT=$(run --ticket TKT-012)
check "list: indexes" "$(printf '%s' "$OUT" | jq -c '[.acceptance[] | [.index, .text, .source]]')" '[[0,"has a header row","reject"],[1,"tests pass","decompose"]]'
check "list: header" "$(printf '%s' "$OUT" | jq -r '.tkt + " " + .column')" "TKT-012 in_progress"

# --- record a check (resolves TKT → id, sends index/result/evidence as the agent) ---
OUT=$(run --ticket TKT-012 --index 1 --result pass --evidence "npm test green")
check "check: path" "$(jq -r .path "$STUB_LOG")" "/api/tickets/tid-12/self-check"
check "check: body" "$(jq -c .body "$STUB_LOG")" '{"index":1,"result":"pass","evidence":"npm test green"}'
check "check: agent header" "$(jq -r .agent "$STUB_LOG")" "ella"
check "check: output" "$(printf '%s' "$OUT" | jq -c '[.success, .acceptance[1].selfCheck]')" '[true,"pass"]'

# --- JSON input, no evidence ---
run '{"ticket":"TKT-012","index":0,"result":"fail"}' >/dev/null
check "json: body" "$(jq -c .body "$STUB_LOG")" '{"index":0,"result":"fail"}'

# --- validation ---
check "bad result" "$(run_err --ticket TKT-012 --index 0 --result maybe | grep -c 'pass or fail')" "1"
check "bad index" "$(run_err --ticket TKT-012 --index x --result pass | grep -c 'must be a number')" "1"
check "missing ticket" "$(run_err --index 0 --result pass | grep -ci 'ticket')" "1"

echo "ticket-check: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
