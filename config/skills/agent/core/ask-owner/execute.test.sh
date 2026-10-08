#!/bin/bash
# Tests for ask-owner — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts the calls and the output.
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
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_GET(self):
        open(LOG, 'w').write(json.dumps({'method': self.command, 'path': self.path, 'body': {}, 'agent': self.headers.get('X-Agent-Session')}))
        if self.path.startswith('/api/decisions/D-11'):
            return self.reply(200, {'success': True, 'data': {'id': 'D-11', 'status': 'open', 'options': [{'key': 'a', 'label': 'Reply with this draft'}, {'key': 'b', 'label': 'Change the wording'}]}})
        if self.path.startswith('/api/decisions/D-12'):
            return self.reply(200, {'success': True, 'data': {'id': 'D-12', 'status': 'resolved', 'chosenKey': 'a', 'answeredVia': 'button', 'resolvedAt': 't', 'options': [{'key': 'a', 'label': 'Reply with this draft'}, {'key': 'b', 'label': 'Change the wording'}]}})
        if self.path.startswith('/api/decisions?status=open'):
            return self.reply(200, {'success': True, 'data': [
                {'id': 'D-20', 'asker': 'dev-ann', 'status': 'open', 'question': 'Ship it?', 'kind': 'reply_question', 'createdAt': 't', 'card': {'slackChannelId': 'C1', 'messageTs': '2.2', 'threadTs': '1.1'}},
                {'id': 'D-21', 'asker': 'dev-bob', 'status': 'open', 'question': 'Other?', 'createdAt': 't'},
                {'id': 'D-22', 'asker': 'dev-ann', 'status': 'open', 'question': 'Top-level?', 'createdAt': 't', 'card': {'slackChannelId': 'C1', 'messageTs': '3.3'}}]})
        return self.reply(200, {'success': True})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = json.loads(self.rfile.read(n).decode() or '{}')
        open(LOG, 'w').write(json.dumps({'method': self.command, 'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
        if self.path.endswith('/cancel'):
            return self.reply(200, {'success': True, 'data': {'id': 'D-7', 'status': 'cancelled'}})
        if len(body.get('options', [])) < 2:
            return self.reply(400, {'success': False, 'error': 'options are required: give the owner 2–3 concrete choices'})
        return self.reply(201, {'success': True, 'data': {'id': 'D-7', 'asker': 'dev-ann', 'status': 'open', 'deadline': 'x', 'card': {'slackChannelId': 'C1'}}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=dev-ann CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=dev-ann CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }
last() { jq -r "$1" "$STUB_LOG"; }

OUT=$(run --question "Send the partner email on Monday?" --option "Send Monday — after review" --option "Hold" --default Hold --ticket APP-12 --project p1 --sensitive email)
check "ask: path" "$(last .path)" "/api/decisions"
check "ask: agent header" "$(last .agent)" "dev-ann"
check "ask: body" "$(last '.body | tostring')" '{"question":"Send the partner email on Monday?","options":["Send Monday — after review","Hold"],"default":"Hold","sensitive":"email","ticket":"APP-12","project":"p1"}'
check "ask: output" "$(printf '%s' "$OUT" | jq -c '.decision')" '{"id":"D-7","asker":"dev-ann","status":"open","deadline":"x","posted":true,"postError":null,"reused":false}'

run '{"question":"Blue or green for the logo?","options":["Blue","Green"],"default":"wait"}' >/dev/null
check "ask json: body" "$(last '.body | tostring')" '{"question":"Blue or green for the logo?","options":["Blue","Green"],"default":"wait"}'

check "ask: server error reaches the agent" "$(run_err --question "Thoughts on this one?" --option "A" | grep -c 'options are required')" "1"
check "ask: missing question" "$(run_err --option A --option B | grep -c 'question')" "1"

OUT=$(run --cancel D-7)
check "cancel: path" "$(last .path)" "/api/decisions/D-7/cancel"
check "cancel: output" "$(printf '%s' "$OUT" | jq -c '.decision')" '{"id":"D-7","status":"cancelled"}'
check "cancel: no reason → empty body" "$(last .body | jq -c .)" '{}'
run --cancel D-7 --reason "already answered in the thread" >/dev/null
check "cancel: reason sent as note" "$(last .body.note)" "already answered in the thread"

# --withdraw: the same as --cancel (a card posted by mistake)
OUT=$(run --withdraw D-7 --reason "posted by mistake")
check "withdraw: path" "$(last .path)" "/api/decisions/D-7/cancel"
check "withdraw: reason sent as note" "$(last .body.note)" "posted by mistake"
check "withdraw: output" "$(printf '%s' "$OUT" | jq -c '.decision')" '{"id":"D-7","status":"cancelled"}'
run '{"withdraw":"D-7"}' >/dev/null
check "withdraw json: path" "$(last .path)" "/api/decisions/D-7/cancel"

# --mine: only the caller's open cards, with their thread
OUT=$(run --mine)
check "mine: path" "$(last .path)" "/api/decisions?status=open"
check "mine: own cards only" "$(printf '%s' "$OUT" | jq -c '[.decisions[] | {id, kind, thread}]')" '[{"id":"D-20","kind":"reply_question","thread":"C1:1.1"},{"id":"D-22","kind":"ask-owner","thread":"C1:3.3"}]'

# --status: an agent reads a card before acting (2026-10-03 phantom owner input)
OUT=$(run --status D-11)
check "status: path" "$(last .path)" "/api/decisions/D-11"
check "status: open card is not an answer" "$(printf '%s' "$OUT" | jq -c '.decision | {status, answered, chosen}')" '{"status":"open","answered":false,"chosen":null}'
OUT=$(run --status D-12)
check "status: answered card names the choice" "$(printf '%s' "$OUT" | jq -c '.decision | {status, answered, chosen, answeredVia}')" '{"status":"resolved","answered":true,"chosen":"Reply with this draft","answeredVia":"button"}'

echo "ask-owner: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
