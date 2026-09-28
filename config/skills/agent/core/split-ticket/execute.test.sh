#!/bin/bash
# Tests for split-ticket — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts the calls and the output.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18832
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
TICKET = {'id': 'tid-39', 'title': '开issue', 'discussion': [
  {'ref': 'slackch-C1-2.0', 'at': '2026-09-26T14:59:36Z', 'author': 'U1', 'text': '可以去研究一下opus做视频那个吗'},
  {'ref': 'slackch-C1-3.0', 'at': '2026-09-26T15:03:01Z', 'author': 'U1', 'text': 'hindsight那个要写到一起吗？'}]}
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_GET(self):
        if self.path == '/api/tickets/TKT-039':
            return self.reply(200, {'success': True, 'data': {'ticket': TICKET, 'board': {'tkt': 'TKT-039'}}})
        return self.reply(404, {'success': False, 'error': 'Ticket not found'})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = json.loads(self.rfile.read(n).decode() or '{}')
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
        if self.path != '/api/tickets/TKT-039/split':
            return self.reply(404, {'success': False, 'error': 'Ticket not found', 'code': 'not_found'})
        if body.get('discussionRef') == 'nope':
            return self.reply(404, {'success': False, 'error': 'No discussion entry nope on that ticket', 'code': 'discussion_not_found'})
        new = {'id': 'tid-41', 'ticketNumber': 41, 'title': body.get('title', 'opus 视频'), 'parentTicketId': 'tid-39',
               'origin': {'threadRef': 'slack:C1:1.0'}}
        return self.reply(201, {'success': True, 'data': {'ticket': new, 'source': TICKET, 'moved': 'discussionRef' in body}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=atlas CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=atlas CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

# --- list mode shows the follow-ups with their refs, and how many ---
OUT=$(run --ticket TKT-039 --list)
check "list: count" "$(printf '%s' "$OUT" | jq -r .count)" "2"
check "list: refs" "$(printf '%s' "$OUT" | jq -c '[.followUps[].ref]')" '["slackch-C1-2.0","slackch-C1-3.0"]'

# --- move a follow-up out (as the agent) ---
OUT=$(run --ticket TKT-039 --discussion-ref slackch-C1-2.0)
check "move: path" "$(jq -r .path "$STUB_LOG")" "/api/tickets/TKT-039/split"
check "move: body" "$(jq -c .body "$STUB_LOG")" '{"question":false,"discussionRef":"slackch-C1-2.0"}'
check "move: agent header" "$(jq -r .agent "$STUB_LOG")" "atlas"
check "move: new ticket keeps the thread and parent" "$(printf '%s' "$OUT" | jq -c '[.success, .moved, .newTicket.ticketNumber, .newTicket.parentTicketId, .newTicket.threadRef]')" '[true,true,41,"tid-39","slack:C1:1.0"]'

# --- split from text, with title / assignee / question ---
run --ticket TKT-039 --text "Turing 的另一个测试是什么" --title "other Turing test" --assignee think-tank-atlas --question >/dev/null
check "text: body" "$(jq -c .body "$STUB_LOG")" '{"question":true,"text":"Turing 的另一个测试是什么","title":"other Turing test","assignee":"think-tank-atlas"}'

# --- JSON input ---
run '{"ticket":"TKT-039","discussionRef":"slackch-C1-3.0"}' >/dev/null
check "json: body" "$(jq -c .body "$STUB_LOG")" '{"question":false,"discussionRef":"slackch-C1-3.0"}'

# --- errors ---
check "unknown ref fails loudly" "$(run_err --ticket TKT-039 --discussion-ref nope | grep -c 'No discussion entry')" "1"
check "nothing to split" "$(run_err --ticket TKT-039 | grep -c 'discussion-ref')" "1"
check "missing ticket" "$(run_err --text x | grep -ci 'ticket')" "1"

echo "split-ticket: ${PASS} passed, ${FAIL} failed ($((PASS+FAIL)) checks)"
[ "$FAIL" -eq 0 ] && [ $((PASS+FAIL)) -gt 0 ]
