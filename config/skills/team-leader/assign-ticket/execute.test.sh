#!/bin/bash
# Tests for assign-ticket (TL) — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts the call and the output.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18842
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
        return self.reply(200, {'ok': True})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = json.loads(self.rfile.read(n).decode() or '{}')
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
        if body.get('assignee') == 'outsider':
            return self.reply(403, {'success': False, 'error': 'outsider is not on a team that works on APP-1'})
        started = body.get('start', True)
        t = {'id': 'APP-1', 'title': 'Export', 'status': 'in_progress' if started else 'ready', 'priority': 'P1',
             'assignee': body['assignee'], 'workItemId': 'wi-1' if started else None}
        data = {'ticket': t}
        if started: data['workItem'] = {'id': 'wi-1'}
        return self.reply(200, {'success': True, 'data': data})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=tl-sam CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=tl-sam CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

OUT=$(run --project /work/app --id APP-1 --to dev-ann)
check "path (project path encoded)" "$(jq -r .path "$STUB_LOG")" "/api/project-tickets/%2Fwork%2Fapp/APP-1/assign"
check "body" "$(jq -c .body "$STUB_LOG")" '{"assignee":"dev-ann","start":true}'
check "header" "$(jq -r .agent "$STUB_LOG")" "tl-sam"
check "output" "$(printf '%s' "$OUT" | jq -c '[.ticket.status, .ticket.assignee, .workItemId]')" '["in_progress","dev-ann","wi-1"]'

OUT=$(run '{"project":"p1","id":"APP-1","to":"dev-bo","start":false}')
check "json no-start body" "$(jq -c .body "$STUB_LOG")" '{"assignee":"dev-bo","start":false}'
check "no-start output" "$(printf '%s' "$OUT" | jq -c '[.ticket.status, .workItemId]')" '["ready",null]'
run --project p1 --id APP-1 --to dev-bo --no-start >/dev/null
check "flag no-start" "$(jq -c .body.start "$STUB_LOG")" "false"

check "403 surfaces" "$(run_err --project p1 --id APP-1 --to outsider | grep -c '403')" "1"
check "missing to" "$(run_err --project p1 --id APP-1 | grep -c 'to')" "1"
check "unknown option" "$(run_err --bogus | grep -c 'Unknown option')" "1"

echo "assign-ticket: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
