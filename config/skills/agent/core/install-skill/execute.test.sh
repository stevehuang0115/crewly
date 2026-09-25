#!/bin/bash
# Tests for install-skill — run with: bash execute.test.sh </dev/null
# A python HTTP stub plays the backend; asserts the request body, the
# X-Agent-Authorization citation and how refusals are reported.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18852
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import base64, json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def reply(self, code, body):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        auth = self.headers.get('X-Agent-Authorization')
        if auth and auth.startswith('b64:'):
            auth = base64.b64decode(auth[4:]).decode()
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session'), 'auth': auth}))
        if body['id'] == 'shady-ocr' and not body.get('approvedByOwner'):
            return self.reply(403, {'success': False, 'code': 'owner_approval_required', 'error': '"shady-ocr" is a third-party skill. Ask the owner in chat…'})
        if body['id'] == 'ready-one':
            return self.reply(200, {'success': True, 'data': {'state': 'already-ready', 'skillId': 'ready-one', 'executePath': '/x/execute.sh', 'next': 'use it now'}})
        self.reply(202, {'success': True, 'data': {'jobId': 'job1', 'skillId': body['id'], 'state': 'running', 'official': True,
                                                   'estimatedMinutes': 6, 'willNotify': ['test-agent'], 'next': 'Installing…'}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -rs 'last.error' 2>/dev/null; }

OUT=$(run --id transcribe-audio --resume "transcribe clip.m4a for Steve")
check "path" "$(jq -r .path "$STUB_LOG")" "/api/skill-setup/install"
check "body" "$(jq -c .body "$STUB_LOG")" '{"id":"transcribe-audio","resume":"transcribe clip.m4a for Steve"}'
check "agent header (who gets the completion message)" "$(jq -r .agent "$STUB_LOG")" "test-agent"
check "no citation by default" "$(jq -r .auth "$STUB_LOG")" "null"
check "job returned at once" "$(printf '%s' "$OUT" | jq -c '{success, jobId, state, estimatedMinutes}')" '{"success":true,"jobId":"job1","state":"running","estimatedMinutes":6}'

OUT=$(run --id shady-ocr); RC=$?
check "third-party: exit 1" "$RC" "1"
check "third-party: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "owner_approval_required"
check "third-party: next says ask the owner" "$(printf '%s' "$OUT" | jq -r .next)" "Ask the owner in chat before installing this third-party skill."

OUT=$(run --id shady-ocr --approved-by-owner --owner-said "好的，装 shady-ocr")
check "approved: flag sent" "$(jq -c .body "$STUB_LOG")" '{"id":"shady-ocr","approvedByOwner":true}'
check "approved: owner quote travels as X-Agent-Authorization" "$(jq -r .auth "$STUB_LOG")" "好的，装 shady-ocr"
check "approved: job" "$(printf '%s' "$OUT" | jq -r .jobId)" "job1"

OUT=$(run '{"id":"pdf-tools","force":true}')
check "json input" "$(jq -c .body "$STUB_LOG")" '{"id":"pdf-tools","force":true}'

OUT=$(run --id ready-one)
check "already ready" "$(printf '%s' "$OUT" | jq -c '{state, executePath}')" '{"state":"already-ready","executePath":"/x/execute.sh"}'

check "missing id" "$(run_err)" "Missing required parameter: id (--id)"
check "unknown option" "$(run_err --yes)" "Unknown option: --yes"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
