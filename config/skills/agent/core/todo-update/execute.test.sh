#!/bin/bash
# Tests for todo-update — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the request the skill sends and
# the JSON it prints. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18833
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
LIST = {'id': 'L1', 'name': 'Groceries'}
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        open(LOG, 'w').write(json.dumps({'method': method, 'path': self.path, 'body': data}))
        if 'no-grant' in self.path or 'no-grant' in json.dumps(data or {}):
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        path = self.path.split('?')[0]
        if path == '/api/microsoft-todo/lists' and method == 'GET':
            out = {'count': 2, 'lists': [{'id': 'L0', 'name': 'Tasks', 'isDefault': True}, LIST]}
        elif path == '/api/microsoft-todo/lists':
            out = {'id': 'L9', 'name': (data or {}).get('name')}
        elif path == '/api/microsoft-todo/tasks' and method == 'GET':
            out = {'list': LIST, 'count': 1, 'tasks': [{'id': 'T1', 'title': 'Milk', 'status': 'notStarted', 'due': '2026-10-01'}]}
        elif path == '/api/microsoft-todo/tasks':
            out = {'list': LIST, 'task': {'id': 'T2', 'title': (data or {}).get('title'), 'status': 'notStarted'}}
        elif method == 'PATCH':
            out = {'list': LIST, 'task': {'id': path.rsplit('/', 1)[1], 'title': 'Milk', 'status': 'completed'}}
        elif method == 'DELETE':
            out = {'list': LIST, 'taskId': path.rsplit('/', 1)[1], 'deleted': True}
        else:
            out = {}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': out}).encode())
    def _body(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        return json.loads(body or '{}')
    def do_GET(self): self._reply('GET')
    def do_DELETE(self): self._reply('DELETE')
    def do_POST(self): self._reply('POST', self._body())
    def do_PATCH(self): self._reply('PATCH', self._body())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }
last() { jq -c "$1" "$STUB_LOG"; }

OUT=$(run --list Groceries --task "AA/k=" --complete)
check "complete: output" "$OUT" '{"success":true,"list":"Groceries","task":{"id":"AA%2Fk%3D","title":"Milk","status":"completed"}}'
check "complete: request" "$(last '[.method,.path,.body]')" '["PATCH","/api/microsoft-todo/tasks/AA%2Fk%3D",{"list":"Groceries","complete":true}]'
run --task T1 --title "Oat milk" --due 2026-10-03 --importance low >/dev/null
check "edit: body" "$(last '.body')" '{"title":"Oat milk","due":"2026-10-03","importance":"low"}'
run --task T1 --due none --reopen >/dev/null
check "clear due + reopen" "$(last '.body')" '{"complete":false,"due":null}'
OUT=$(run --list Work --task T1 --delete)
check "delete: output" "$OUT" '{"success":true,"deleted":true,"list":"Groceries","taskId":"T1"}'
check "delete: request" "$(last '[.method,.path]')" '["DELETE","/api/microsoft-todo/tasks/T1?list=Work"]'
run '{"list":"Work","task":"T7","complete":true}' >/dev/null
check "json input" "$(last '[.path,.body]')" '["/api/microsoft-todo/tasks/T7",{"list":"Work","complete":true}]'
check "task required" "$(run_err --complete | jq -r .error)" "--task is required (ids come from todo-tasks)"
check "nothing to change" "$(run_err --task T1 | jq -r .error | cut -c1-17)" "nothing to change"
check "bad due" "$(run_err --task T1 --due 1/10 | jq -r .error)" "--due must look like 2026-10-01, or none to clear it"
OUT=$(run --list no-grant --task T1 --complete || true)
check "not connected" "$(printf '%s' "$OUT" | jq -r .reason)" "not_connected"

echo "todo-update: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
