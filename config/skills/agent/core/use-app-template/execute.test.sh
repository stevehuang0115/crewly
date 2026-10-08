#!/bin/bash
# Tests for use-app-template — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the request, the files written and the JSON printed.
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
import json, os, base64
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
b = lambda s: base64.b64encode(s.encode()).decode()
FILES = [{'path': 'index.html', 'contentBase64': b('<h1>Chores</h1>')}, {'path': 'js/app.js', 'contentBase64': b('go()')}]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); data = json.loads(self.rfile.read(n).decode() or '{}')
        open(LOG, 'w').write(json.dumps({'path': self.path, 'body': data, 'session': self.headers.get('X-Agent-Session'), 'badge': self.headers.get('X-Agent-Badge')}))
        def send(code, obj):
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(obj).encode())
        if self.path == '/api/apps/templates/tpl-fuzzfuzzfu/use':
            return send(402, {'success': False, 'error': 'quota_exceeded', 'message': 'This account already has 10 apps'})
        if self.path == '/api/apps/templates/tpl-badbadbadb/use':
            return send(201, {'success': True, 'data': {'appId': 'newapp2345', 'name': 'X', 'url': 'u', 'version': 1, 'fromTemplate': {}, 'entry': 'index.html',
                'files': [{'path': '../escape.txt', 'contentBase64': b('x')}]}})
        if self.path.startswith('/api/apps/templates/') and self.path.endswith('/use'):
            return send(201, {'success': True, 'data': {'appId': 'newapp2345', 'name': data.get('name', 'Chore chart'), 'url': 'https://apps.crewlyai.com/newapp2345', 'version': 1,
                'fromTemplate': {'templateId': 'tpl-k3m9p2x7aq', 'version': 3, 'name': 'Chore chart'}, 'capabilitiesNeeded': [],
                'dataSchema': [{'collection': 'chores', 'fields': [{'name': 'title', 'type': 'string'}]}], 'entry': 'index.html', 'files': FILES}})
        if self.path == '/api/apps/28au74d9cj/template-files':
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'name': 'Ours', 'url': 'https://apps.crewlyai.com/28au74d9cj', 'version': 2,
                'fromTemplate': {'templateId': 'tpl-k3m9p2x7aq', 'version': 3, 'name': 'Chore chart'}, 'entry': 'index.html', 'files': FILES}})
        send(404, {'success': False, 'error': 'not_found', 'message': 'Template not found.'})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done
mkdir -p "$WORK/home/.crewly" "$WORK/proj"
ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella CREWLY_AGENT_BADGE=badge1 CREWLY_PROJECT_PATH="$WORK/proj" HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly")
run() { (cd "$WORK/proj" && env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null); }
run_err() { (cd "$WORK/proj" && env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null); }

OUT=$(run tpl-k3m9p2x7aq --dir ./chores --name "Chores for Milo")
check "use: request (source = the real dir, identity headers)" "$(jq -c '{path, body, session, badge}' "$STUB_LOG")" '{"path":"/api/apps/templates/tpl-k3m9p2x7aq/use","body":{"source":"'"$WORK"'/proj/chores","name":"Chores for Milo"},"session":"dev-ella","badge":"badge1"}'
check "use: files written" "$(cat "$WORK/proj/chores/index.html") $(cat "$WORK/proj/chores/js/app.js")" '<h1>Chores</h1> go()'
check "use: output" "$(printf '%s' "$OUT" | jq -c '{success, appId, name, version, fromTemplate, dir, files, dataSchema}')" '{"success":true,"appId":"newapp2345","name":"Chores for Milo","version":1,"fromTemplate":{"templateId":"tpl-k3m9p2x7aq","version":3,"name":"Chore chart"},"dir":"'"$WORK"'/proj/chores","files":2,"dataSchema":[{"collection":"chores","fields":[{"name":"title","type":"string"}]}]}'
check "use: next says adapt, publish from the dir, tell the owner" "$(printf '%s' "$OUT" | jq -r '.next' | grep -c "publish-app --dir $WORK/proj/chores --notify.*started from the Marketplace template “Chore chart”")" "1"

OUT=$(run --app 28au74d9cj --dir ./ours)
check "checkout: request" "$(jq -c '{path, body}' "$STUB_LOG")" '{"path":"/api/apps/28au74d9cj/template-files","body":{"source":"'"$WORK"'/proj/ours"}}'
check "checkout: files + output" "$(cat "$WORK/proj/ours/index.html") $(printf '%s' "$OUT" | jq -c '{appId, version}')" '<h1>Chores</h1> {"appId":"28au74d9cj","version":2}'

check "a non-empty dir is refused (nothing overwritten)" "$(run_err tpl-k3m9p2x7aq --dir ./chores | grep -c 'is not empty')" "1"
mkdir -p "$WORK/outside"
check "a dir outside the project is refused" "$(run_err tpl-k3m9p2x7aq --dir "$WORK/outside/x" | grep -c 'inside your project')" "1"
check "the project root itself is refused" "$(run_err tpl-k3m9p2x7aq --dir . | grep -c 'inside your project')" "1"
mkdir -p "$WORK/real"; ln -s "$WORK/real" "$WORK/proj/link"
check "a symlinked dir is refused" "$(run_err tpl-k3m9p2x7aq --dir ./link | grep -c 'symbolic link')" "1"
check "Crewly home refused" "$( (cd "$WORK/home" && env "${ENVS[@]}" CREWLY_PROJECT_PATH="$WORK/home" bash "$EXEC" tpl-k3m9p2x7aq --dir ./.crewly/x 2>&1 >/dev/null) | grep -c "Crewly's home")" "1"
check "bad template id" "$(run_err tpl-nope --dir ./a | grep -c 'tpl-xxxxxxxxxx')" "1"
check "dir required" "$(run_err tpl-k3m9p2x7aq | grep -c -- '--dir is required')" "1"

OUT=$(run tpl-fuzzfuzzfu --dir ./full; true)
check "quota refusal mapped, no dir created" "$(printf '%s' "$OUT" | jq -c '{success, status, reason}') $([ -e "$WORK/proj/full" ] && echo made || echo none)" '{"success":false,"status":402,"reason":"quota_exceeded"} none'
OUT=$(run_err tpl-badbadbadb --dir ./evil; true)
check "an unsafe path from the server is refused" "$(printf '%s' "$OUT" | grep -c 'unsafe file path') $([ -e "$WORK/proj/escape.txt" ] && echo escaped || echo safe)" "1 safe"

echo "use-app-template: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
