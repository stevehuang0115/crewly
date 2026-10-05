#!/bin/bash
# Tests for app-comments — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the requests the skill sends and
# the JSON it prints. Separate HOME / CREWLY_HOME. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18843
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
THREAD = {'id': 'c1', 'number': 3, 'version': 4, 'status': 'open', 'body': 'Make this green', 'createdAt': 't',
          'anchor': {'crewlyId': 'save-btn', 'selector': 'button#save', 'text': 'Save', 'tag': 'button'},
          'author': {'kind': 'owner', 'name': 'Owner'},
          'replies': [{'id': 'r1', 'body': 'Which green?', 'author': {'kind': 'agent', 'name': 'Ella', 'id': 'dev-ella'}, 'createdAt': 't2'}],
          'resolvedAt': None, 'resolvedBy': None}
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        with open(LOG, 'a') as f: f.write(json.dumps({'method': method, 'path': self.path, 'body': data}) + '\n')
        def send(code, obj):
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(obj).encode())
        if '/missing' in self.path:
            return send(404, {'success': False, 'error': 'not_found', 'message': 'Comment not found.'})
        if method == 'GET' and '?status=' in self.path:
            return send(200, {'success': True, 'data': {'comments': [THREAD]}})
        if method == 'GET' and self.path.endswith('/comments/m1'):
            t = dict(THREAD); t['id'] = 'm1'
            t['mentions'] = [{'session': 'crewly-research-atlas-0a1b2c3d', 'name': 'Atlas', 'instanceId': 'i1'}]
            t['replies'] = [{'id': 'r2', 'body': '@Nova too', 'author': {'kind': 'owner', 'name': 'Owner'}, 'createdAt': 't3',
                             'mentions': [{'session': 'crewly-ops-nova-99887766', 'name': 'Nova', 'instanceId': 'i2'}]}]
            return send(200, {'success': True, 'data': t})
        t = dict(THREAD)
        if self.path.endswith('/resolve'):
            t['status'] = 'resolved'; t['resolvedBy'] = {'kind': 'agent', 'name': 'Ella'}
        send(201 if self.path.endswith('/replies') else 200, {'success': True, 'data': t})
    def do_GET(self): self._reply('GET')
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        self._reply('POST', json.loads(body) if body else None)
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
WORK="$(mktemp -d)"; mkdir -p "$WORK/home/.crewly"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly")
run() { : > "$STUB_LOG"; env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null; }
# The skill library's start-of-skill heartbeat is not part of what we test.
reqs() { jq -c 'select(.path != "/api/heartbeat") | {method, path, body}' "$STUB_LOG" | paste -sd'|' -; }
A=28au74d9cj

OUT=$(run --app $A --list)
check "list: request" "$(reqs)" "{\"method\":\"GET\",\"path\":\"/api/apps/$A/comments?status=open\",\"body\":null}"
check "list: output" "$OUT" '{"success":true,"comments":[{"id":"c1","number":3,"status":"open","version":4,"on":{"crewlyId":"save-btn","selector":"button#save","text":"Save","tag":"button"},"comment":"Make this green","at":"t","replies":[{"from":"Ella","text":"Which green?","at":"t2"}],"resolvedBy":null}]}'

run --app $A --list --status all >/dev/null
check "list all" "$(jq -r 'select(.path != "/api/heartbeat") | .path' "$STUB_LOG")" "/api/apps/$A/comments?status=all"

OUT=$(run --app $A --get c1)
check "get" "$(printf '%s' "$OUT" | jq -c '{success, id: .comment.id, on: .comment.on.crewlyId}')" '{"success":true,"id":"c1","on":"save-btn"}'

OUT=$(run --app $A --get m1)
check "get: @mentions shown as to" "$(printf '%s' "$OUT" | jq -c '{to: .comment.to, replies: .comment.replies}')" '{"to":["Atlas"],"replies":[{"from":"owner","text":"@Nova too","at":"t3","to":["Nova"]}]}'

OUT=$(run --app $A --reply c1 --text 'Which "green"?')
check "reply: request" "$(reqs)" "{\"method\":\"POST\",\"path\":\"/api/apps/$A/comments/c1/replies\",\"body\":{\"text\":\"Which \\\"green\\\"?\"}}"
check "reply: output" "$OUT" '{"success":true,"id":"c1","number":3,"replies":1,"status":"open"}'

OUT=$(run --app $A --resolve c1 --text "Done in v5")
check "resolve with text: reply then resolve" "$(reqs)" "{\"method\":\"POST\",\"path\":\"/api/apps/$A/comments/c1/replies\",\"body\":{\"text\":\"Done in v5\"}}|{\"method\":\"POST\",\"path\":\"/api/apps/$A/comments/c1/resolve\",\"body\":null}"
check "resolve: output" "$OUT" '{"success":true,"id":"c1","number":3,"status":"resolved","replies":1}'

run --app $A --reopen c1 >/dev/null
check "reopen" "$(reqs)" "{\"method\":\"POST\",\"path\":\"/api/apps/$A/comments/c1/reopen\",\"body\":null}"

OUT=$(run --app $A --get missing; true)
check "missing → not_found" "$(printf '%s' "$OUT" | jq -c '{success, status, reason}')" '{"success":false,"status":404,"reason":"not_found"}'

OUT=$(run_err --app $A --reply c1 || true)
check "reply needs text" "$(printf '%s' "$OUT" | grep -c 'needs --text')" "1"
OUT=$(run_err --app $A --reply '../x' --text hi || true)
check "bad comment id refused" "$(printf '%s' "$OUT" | grep -c 'comment id')" "1"
OUT=$(run_err --app $A --reply c1 --text "$(printf 'x%.0s' $(seq 1 2001))" || true)
check "text over 2000 refused" "$(printf '%s' "$OUT" | grep -c 'at most 2000')" "1"
OUT=$(run_err --app $A --list --status maybe || true)
check "bad status refused" "$(printf '%s' "$OUT" | grep -c 'open, resolved or all')" "1"
OUT=$(run_err --list || true)
check "app required" "$(printf '%s' "$OUT" | grep -c 'app is required')" "1"

echo "app-comments: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
