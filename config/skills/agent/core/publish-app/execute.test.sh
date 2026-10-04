#!/bin/bash
# Tests for publish-app — run with: bash execute.test.sh
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

PORT=18841
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        open(LOG, 'w').write(json.dumps({'method': method, 'path': self.path, 'body': data,
            'badge': self.headers.get('X-Agent-Badge'), 'session': self.headers.get('X-Agent-Session')}))
        def send(code, obj):
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(obj).encode())
        if (data or {}).get('name') == 'nologin':
            return send(409, {'success': False, 'error': 'not_logged_in', 'message': 'not signed in', 'hint': 'crewly cloud login'})
        if self.path == '/api/apps/publish':
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'name': data.get('name', 'x'), 'url': 'https://apps.crewlyai.com/28au74d9cj',
                'version': 3, 'created': False, 'notified': bool(data.get('notify'))}})
        if self.path.endswith('/rollback'):
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'currentVersion': data['version']}})
        if self.path.endswith('/versions'):
            return send(200, {'success': True, 'data': [{'version': 2, 'current': True, 'note': None, 'files': 1, 'totalBytes': 9, 'createdAt': 't', 'entry': 'index.html'}]})
        if self.path == '/api/apps':
            return send(200, {'success': True, 'data': [{'appId': 'a', 'name': 'A', 'url': 'u', 'agentSession': 's', 'currentVersion': 1, 'source': '/x'},
                {'appId': 'b', 'name': 'B', 'deleted': True}]})
        send(404, {'success': False, 'error': 'not_found'})
    def do_GET(self): self._reply('GET')
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        self._reply('POST', json.loads(body or '{}'))
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
WORK="$(mktemp -d)"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella CREWLY_AGENT_BADGE=badge1 bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella CREWLY_AGENT_BADGE=badge1 bash "$EXEC" "$@" 2>&1 >/dev/null; }

APPDIR="$WORK/groceries"
mkdir -p "$APPDIR/js" "$APPDIR/.git" "$APPDIR/node_modules/x"
printf '<h1>hi</h1>' > "$APPDIR/index.html"
printf 'console.log(1)' > "$APPDIR/js/app.js"
printf 'SECRET=1' > "$APPDIR/.env"
printf 'x' > "$APPDIR/.git/config"
printf 'x' > "$APPDIR/node_modules/x/i.js"

OUT=$(run --dir "$APPDIR" --name "Groceries" --note "first" --notify)
check "publish: output" "$OUT" '{"success":true,"appId":"28au74d9cj","name":"Groceries","url":"https://apps.crewlyai.com/28au74d9cj","version":3,"created":false,"notified":true}'
check "publish: files (no dotfiles / node_modules)" "$(jq -c '[.body.files[].path]' "$STUB_LOG")" '["index.html","js/app.js"]'
check "publish: content is base64" "$(jq -r '.body.files[0].contentBase64' "$STUB_LOG" | base64 --decode 2>/dev/null || jq -r '.body.files[0].contentBase64' "$STUB_LOG" | base64 -D)" '<h1>hi</h1>'
check "publish: options" "$(jq -c '{name: .body.name, note: .body.note, notify: .body.notify, sourceSet: (.body.source | endswith("groceries"))}' "$STUB_LOG")" '{"name":"Groceries","note":"first","notify":true,"sourceSet":true}'
check "publish: agent identity headers" "$(jq -c '{badge, session}' "$STUB_LOG")" '{"badge":"badge1","session":"dev-ella"}'

printf '<p>t</p>' > "$WORK/timer.html"
run --html "$WORK/timer.html" --app 28au74d9cj >/dev/null
check "single file → index.html, explicit app" "$(jq -c '{paths: [.body.files[].path], appId: .body.appId, notify: (.body.notify // false)}' "$STUB_LOG")" '{"paths":["index.html"],"appId":"28au74d9cj","notify":false}'

OUT=$(run_err --html "$WORK/timer.txt" || true)
check "missing file refused" "$(printf '%s' "$OUT" | grep -c 'file not found')" "1"
mkdir -p "$WORK/noindex"; printf 'x' > "$WORK/noindex/a.html"
OUT=$(run_err --dir "$WORK/noindex" || true)
check "dir without entry refused" "$(printf '%s' "$OUT" | grep -c 'index.html is not in')" "1"

OUT=$(run --app 28au74d9cj --rollback 2)
check "rollback: output" "$OUT" '{"success":true,"appId":"28au74d9cj","url":"https://apps.crewlyai.com/28au74d9cj","currentVersion":2}'
check "rollback: request" "$(jq -c '{path, body}' "$STUB_LOG")" '{"path":"/api/apps/28au74d9cj/rollback","body":{"version":2}}'

OUT=$(run --app 28au74d9cj --versions)
check "versions" "$OUT" '{"success":true,"versions":[{"version":2,"current":true,"note":null,"files":1,"totalBytes":9,"createdAt":"t"}]}'
OUT=$(run --list)
check "list hides deleted" "$OUT" '{"success":true,"apps":[{"appId":"a","name":"A","url":"u","agent":"s","currentVersion":1,"source":"/x"}]}'

OUT=$(run --dir "$APPDIR" --name nologin; true)
check "backend error mapped" "$OUT" '{"success":false,"status":409,"reason":"not_logged_in","message":"not signed in","hint":"crewly cloud login"}'

echo "publish-app: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
