#!/bin/bash
# Tests for harness-login — run with: bash execute.test.sh </dev/null
# A python HTTP stub plays the backend; asserts the route, the body, the
# orchestrator header and how refusals are reported.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18853
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
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
        if self.headers.get('X-Agent-Session') != 'crewly-orc':
            return self.reply(403, {'success': False, 'code': 'orchestrator_only', 'error': 'Only the orchestrator can start a harness login for the owner. Ask the orchestrator.'})
        if self.path.startswith('/api/harness/codex/'):
            return self.reply(403, {'success': False, 'code': 'owner_request_not_found', 'error': 'No owner message in the last 30 min asks to log Codex in.'})
        if self.path.startswith('/api/harness/antigravity/'):
            return self.reply(400, {'success': False, 'code': 'no_link_login', 'error': 'Antigravity CLI 用的是 Gemini API key', 'next': 'Tell the owner this in one short line, in their language.'})
        self.reply(202, {'success': True, 'data': {'status': 'started', 'harnessId': 'claude-code', 'displayName': 'Claude Code', 'dmAvailable': True, 'next': 'Say nothing more about this login'}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME="${AS:-crewly-orc}" CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=crewly-orc CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -rs 'last.error' 2>/dev/null; }

OUT=$(run --harness claude)
check "route" "$(jq -r .path "$STUB_LOG")" "/api/harness/claude/owner-login"
check "body" "$(jq -c .body "$STUB_LOG")" '{"switchAccount":false}'
check "orchestrator header" "$(jq -r .agent "$STUB_LOG")" "crewly-orc"
check "returns at once with the next step" "$(printf '%s' "$OUT" | jq -c '{success, status, harnessId, dmAvailable}')" '{"success":true,"status":"started","harnessId":"claude-code","dmAvailable":true}'

OUT=$(run --harness "Claude Code" --switch-account)
check "display name → id, switch flag" "$(jq -c '{path, body}' "$STUB_LOG")" '{"path":"/api/harness/claude-code/owner-login","body":{"switchAccount":true}}'

OUT=$(run '{"harness":"claude","switchAccount":true}')
check "json input" "$(jq -c .body "$STUB_LOG")" '{"switchAccount":true}'

OUT=$(run --harness codex); RC=$?
check "no owner request: exit 1" "$RC" "1"
check "no owner request: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "owner_request_not_found"

OUT=$(run --harness antigravity); RC=$?
check "no link login: reason and next" "$(printf '%s' "$OUT" | jq -c '{reason, next}')" '{"reason":"no_link_login","next":"Tell the owner this in one short line, in their language."}'

OUT=$(AS=dev-team-joe run --harness claude)
check "other agents refused" "$(printf '%s' "$OUT" | jq -r .reason)" "orchestrator_only"

check "missing harness" "$(run_err)" "Missing required parameter: harness (--harness)"
check "path injection refused" "$(run_err --harness '../orc')" "Invalid harness: ../orc (use claude, codex or antigravity)"
check "unknown option" "$(run_err --yes)" "Unknown option: --yes"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
