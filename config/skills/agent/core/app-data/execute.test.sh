#!/bin/bash
# Tests for app-data — run with: bash execute.test.sh
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

PORT=18842
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
DOC = {'id': 'milk', 'data': {'name': 'milk', 'done': False}, 'rev': 2, 'updatedAt': 't', 'updatedBy': {'kind': 'owner', 'id': 'u'}}
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        open(LOG, 'w').write(json.dumps({'method': method, 'path': self.path, 'body': data}))
        def send(code, obj):
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(obj).encode())
        if self.path.endswith('/missing'):
            return send(404, {'success': False, 'error': 'not_found', 'message': 'Document not found.', 'hint': 'No such app, document or version for this account.'})
        if self.path.endswith('/collaborators') and method == 'GET':
            return send(200, {'success': True, 'data': {'collaborators': [{'id': 'e1', 'kind': 'team', 'who': 'Marketing', 'name': 'Marketing', 'instanceId': 'i'}]}})
        if self.path.endswith('/collaborators/request'):
            return send(200, {'success': True, 'data': {'requested': True, 'decisionId': 'D-1', 'for': 'the Marketing team'}})
        if self.path.endswith('/byagent'):
            return send(200, {'success': True, 'data': {'docs': [{'id': 'a', 'data': {}, 'rev': 1, 'updatedAt': 't', 'updatedBy': {'kind': 'agent', 'id': 'crewly-marketing-ella-1'}}], 'next': None}})
        if (data or {}).get('ifRev') == 1:
            return send(409, {'success': False, 'error': 'conflict', 'message': 'rev mismatch'})
        if method == 'GET' and '?' in self.path or self.path.endswith('/items'):
            if method == 'GET':
                return send(200, {'success': True, 'data': {'docs': [DOC], 'next': None}})
        if method == 'DELETE':
            return send(200, {'success': True, 'data': {'deleted': True}})
        send(200, {'success': True, 'data': DOC})
    def do_GET(self): self._reply('GET')
    def do_DELETE(self): self._reply('DELETE')
    def _body(self, m):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        self._reply(m, json.loads(body or '{}'))
    def do_POST(self): self._body('POST')
    def do_PUT(self): self._body('PUT')
    def do_PATCH(self): self._body('PATCH')
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

WORK="$(mktemp -d)"; mkdir -p "$WORK/proj" "$WORK/home/.crewly"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$WORK"' EXIT
ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella CREWLY_PROJECT_PATH="$WORK/proj" HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly")
run() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null; }
A=28au74d9cj

OUT=$(run --app $A --list items --limit 50 --after abc)
check "list: output" "$OUT" '{"success":true,"docs":[{"id":"milk","data":{"name":"milk","done":false},"rev":2,"updatedAt":"t","updatedBy":"owner"}],"next":null}'
check "list: path" "$(jq -r .path "$STUB_LOG")" "/api/apps/$A/data/items?limit=50&after=abc"

OUT=$(run --app $A --get items milk)
check "get" "$OUT" '{"success":true,"id":"milk","data":{"name":"milk","done":false},"rev":2,"updatedAt":"t"}'

OUT=$(run --app $A --get items missing; true)
check "get missing → not_found" "$(printf '%s' "$OUT" | jq -c '{success, status, reason}')" '{"success":false,"status":404,"reason":"not_found"}'

run --app $A --set items milk --data '{"done":true}' >/dev/null
check "set: request" "$(jq -c '{method, path, body}' "$STUB_LOG")" "{\"method\":\"PUT\",\"path\":\"/api/apps/$A/data/items/milk\",\"body\":{\"data\":{\"done\":true}}}"

OUT=$(run --app $A --update items milk --data '{"done":true}' --if-rev 2)
check "update: output" "$OUT" '{"success":true,"id":"milk","rev":2}'
check "update: request" "$(jq -c '{method, body}' "$STUB_LOG")" '{"method":"PATCH","body":{"data":{"done":true},"ifRev":2}}'

OUT=$(run --app $A --update items milk --data '{"done":true}' --if-rev 1; true)
check "update conflict" "$(printf '%s' "$OUT" | jq -r .reason)" "conflict"

run --app $A --add items --data '{"name":"eggs"}' >/dev/null
check "add: request" "$(jq -c '{method, path, body}' "$STUB_LOG")" "{\"method\":\"POST\",\"path\":\"/api/apps/$A/data/items\",\"body\":{\"data\":{\"name\":\"eggs\"}}}"

OUT=$(run --app $A --delete items milk)
check "delete" "$OUT" '{"success":true,"deleted":true}'

OUT=$(run_err --app $A --set items milk --data '[1]' || true)
check "non-object data refused" "$(printf '%s' "$OUT" | grep -c 'JSON object')" "1"
OUT=$(run_err --list items || true)
check "app required" "$(printf '%s' "$OUT" | grep -c 'app is required')" "1"

# --data-file: a regular, non-symlink file inside the project only.
printf '{"name":"bread"}' > "$WORK/proj/d.json"
run --app $A --add items --data-file "$WORK/proj/d.json" >/dev/null
check "data-file inside the project" "$(jq -c .body "$STUB_LOG")" '{"data":{"name":"bread"}}'
printf '{"x":1}' > "$WORK/outside.json"
OUT=$(run_err --app $A --add items --data-file "$WORK/outside.json" || true)
check "data-file outside the project refused" "$(printf '%s' "$OUT" | grep -c 'outside your project directory')" "1"
ln -s "$WORK/outside.json" "$WORK/proj/link.json"
OUT=$(run_err --app $A --add items --data-file "$WORK/proj/link.json" || true)
check "symlinked data-file refused" "$(printf '%s' "$OUT" | grep -c 'symbolic link')" "1"
printf '{"token":"t"}' > "$WORK/home/.crewly/c.json"
OUT=$(env "${ENVS[@]}" CREWLY_PROJECT_PATH="$WORK/home" bash "$EXEC" --app $A --add items --data-file "$WORK/home/.crewly/c.json" 2>&1 >/dev/null || true)
check "data-file in Crewly home refused" "$(printf '%s' "$OUT" | grep -c "inside Crewly's home")" "1"
OUT=$(run_err --app $A --get items .. || true)
check "doc id .. refused" "$(printf '%s' "$OUT" | grep -c 'cannot be')" "1"

# A write by an agent shows who (the session); an owner write does not carry an id.
OUT=$(run --app $A --list byagent)
check "list: agent write shows its session" "$(printf '%s' "$OUT" | jq -c '.docs[0] | {updatedBy, by}')" '{"updatedBy":"agent","by":"crewly-marketing-ella-1"}'

# Asking for access: POST .../collaborators/request with the scope and reason only.
OUT=$(run --app $A --request-access --scope agent --reason "write the briefing")
check "request-access: path" "$(jq -r '.method + " " + .path' "$STUB_LOG")" "POST /api/apps/$A/collaborators/request"
check "request-access: body" "$(jq -c .body "$STUB_LOG")" '{"scope":"agent","reason":"write the briefing"}'
check "request-access: output says requested" "$(printf '%s' "$OUT" | jq -c '{success, requested, for}')" '{"success":true,"requested":true,"for":"the Marketing team"}'
OUT=$(run_err --app $A --request-access --scope everyone || true)
check "request-access: bad scope refused" "$(printf '%s' "$OUT" | grep -c 'team or agent')" "1"
OUT=$(run --app $A --collaborators)
check "collaborators: output" "$OUT" '{"success":true,"collaborators":[{"id":"e1","kind":"team","name":"Marketing","who":"Marketing"}]}'

echo "app-data: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
