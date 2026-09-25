#!/bin/bash
# Tests for whatsapp-send — run with: bash execute.test.sh </dev/null
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

PORT=18844
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
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        open(LOG, 'w').write(json.dumps({'method': 'POST', 'path': self.path, 'agent': self.headers.get('X-Agent-Session')}))
        if self.path == '/api/whatsapp/drafts/W12/send':
            return self.reply(200, {'success': True, 'data': {'id': 'd-1', 'code': 'W12', 'status': 'sent', 'sentAt': 1760000000000, 'recipient': 'Ann', 'via': 'owner_confirmation'}})
        if self.path == '/api/whatsapp/drafts/W13/send':
            return self.reply(403, {'success': False, 'code': 'needs_owner_confirmation',
                                    'error': 'The owner has not confirmed draft W13. Ask them to reply 「发 W13」.',
                                    'data': {'code': 'W13', 'reason': 'no_confirmation'}})
        if self.path == '/api/whatsapp/drafts/W14/send':
            return self.reply(409, {'success': False, 'code': 'draft_not_pending', 'error': 'Draft W14 is sent; it cannot be sent'})
        self.reply(404, {'success': False, 'code': 'draft_not_found', 'error': 'No draft'})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

OUT=$(run --draft W12)
check "confirmed: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/drafts/W12/send"
check "confirmed: agent header" "$(jq -r .agent "$STUB_LOG")" "test-agent"
check "confirmed: output" "$OUT" '{"success":true,"sent":true,"code":"W12","recipient":"Ann","sentAt":"2025-10-09T08:53:20Z"}'

run '{"draft":"W12"}' >/dev/null
check "json: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/drafts/W12/send"

OUT=$(run --draft W13); RC=$?
check "unconfirmed: exit code" "$RC" "1"
check "unconfirmed: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "needs_owner_confirmation"
check "unconfirmed: sent false" "$(printf '%s' "$OUT" | jq -r .sent)" "false"
MSG=$(printf '%s' "$OUT" | jq -r .message)
[[ "$MSG" == "NOT SENT: the owner has not confirmed."* && "$MSG" == *"「发 W13」"* ]] && OK=yes || OK=no
check "unconfirmed: clear message" "$OK" "yes"

OUT=$(run --draft W14); RC=$?
check "already sent: exit code" "$RC" "1"
check "already sent: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "draft_not_pending"

# Anonymous calls would look like the owner to the backend — refused locally,
# and no request is made.
: > "$STUB_LOG"
ERR=$(CREWLY_SESSION_NAME= CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --draft W12 2>&1 >/dev/null | jq -r .error); RC=$?
[[ "$ERR" == "CREWLY_SESSION_NAME is not set."* ]] && OK=yes || OK=no
check "no session: refused" "$OK" "yes"
check "no session: no request made" "$(cat "$STUB_LOG")" ""

check "missing draft" "$(run_err)" "Missing required parameter: draft (--draft)"
check "unknown option errors" "$(run_err --force)" "Unknown option: --force"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
