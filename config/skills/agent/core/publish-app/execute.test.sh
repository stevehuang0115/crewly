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
            out = {'appId': '28au74d9cj', 'name': data.get('name', 'x'), 'url': 'https://apps.crewlyai.com/28au74d9cj',
                'version': 3, 'created': False, 'notified': bool(data.get('notify'))}
            if data.get('notify'):
                out.update({'card': 'signed', 'cardPlace': 'owner-dm', 'linkId': 'lnk_1', 'linkExpiresAt': 'e', 'signedUrl': 'https://apps.crewlyai.com/28au74d9cj?k=LEAK'})
            if data.get('publicRequest'):
                if data['publicRequest'].get('note') == 'fail':
                    out.update({'publicRequested': False, 'publicError': 'old cloud'})
                else:
                    out.update({'publicRequested': True, 'notified': True, 'card': 'signed'})
            return send(200, {'success': True, 'data': out})
        if self.path == '/api/apps/28au74d9cj/share':
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'name': 'G', 'url': 'https://apps.crewlyai.com/28au74d9cj?k=LEAK', 'visibility': 'private',
                'publicRequestPending': False, 'notified': True, 'card': 'signed', 'cardPlace': 'owner-dm', 'linkId': 'lnk_2', 'linkExpiresAt': 'e'}})
        if self.path == '/api/apps/28au74d9cj/links' and method == 'GET':
            return send(200, {'success': True, 'data': [{'linkId': 'lnk_1', 'active': True, 'uses': 2, 'createdAt': 'c', 'expiresAt': 'e', 'lastUsedAt': None, 'revokedAt': None, 'createdBy': 'dev-ella', 'url': 'LEAK'}]})
        if self.path == '/api/apps/28au74d9cj/links' and method == 'DELETE':
            return send(200, {'success': True, 'data': {'revoked': 3}})
        if self.path == '/api/apps/28au74d9cj/links/lnk_1':
            return send(200, {'success': True, 'data': {'revoked': True}})
        if self.path == '/api/apps/28au74d9cj/links/nope':
            return send(404, {'success': False, 'error': 'not_found', 'message': 'No such link.'})
        if self.path == '/api/apps/28au74d9cj/visibility-request' and method == 'POST':
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'visibility': 'private', 'publicRequest': dict(data, requestedBy='dev-ella'),
                'message': 'x', 'notified': True, 'card': 'signed', 'cardPlace': 'owner-dm', 'linkId': 'lnk_3'}})
        if self.path == '/api/apps/28au74d9cj/visibility-request' and method == 'DELETE':
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'cancelled': True, 'visibility': 'private'}})
        if self.path == '/api/apps/28au74d9cj/make-private':
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'visibility': 'private'}})
        if self.path.endswith('/rollback'):
            return send(200, {'success': True, 'data': {'appId': '28au74d9cj', 'currentVersion': data['version']}})
        if self.path.endswith('/versions'):
            return send(200, {'success': True, 'data': [{'version': 2, 'current': True, 'note': None, 'files': 1, 'totalBytes': 9, 'createdAt': 't', 'entry': 'index.html'}]})
        if self.path == '/api/apps':
            return send(200, {'success': True, 'data': [{'appId': 'a', 'name': 'A', 'url': 'u', 'agentSession': 's', 'currentVersion': 1, 'source': '/x'},
                {'appId': 'b', 'name': 'B', 'deleted': True}]})
        send(404, {'success': False, 'error': 'not_found'})
    def do_GET(self): self._reply('GET')
    def do_DELETE(self): self._reply('DELETE')
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

mkdir -p "$WORK/home/.crewly"
ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella CREWLY_AGENT_BADGE=badge1 CREWLY_PROJECT_PATH="$WORK" HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly")
run() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

APPDIR="$WORK/groceries"
mkdir -p "$APPDIR/js" "$APPDIR/.git" "$APPDIR/node_modules/x"
printf '<h1>hi</h1>' > "$APPDIR/index.html"
printf 'console.log(1)' > "$APPDIR/js/app.js"
printf 'SECRET=1' > "$APPDIR/.env"
printf 'x' > "$APPDIR/.git/config"
printf 'x' > "$APPDIR/node_modules/x/i.js"

OUT=$(run --dir "$APPDIR" --name "Groceries" --note "first" --notify)
check "publish: output (card fields, never the signed link)" "$OUT" '{"success":true,"appId":"28au74d9cj","name":"Groceries","url":"https://apps.crewlyai.com/28au74d9cj","version":3,"created":false,"notified":true,"card":"signed","cardPlace":"owner-dm","linkId":"lnk_1","linkExpiresAt":"e"}'
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

# The bundle root must be a real path inside the project, never Crewly's home.
OUTSIDE="$(mktemp -d)"; printf '<p>o</p>' > "$OUTSIDE/index.html"
OUT=$(run_err --dir "$OUTSIDE" || true)
check "dir outside the project refused" "$(printf '%s' "$OUT" | grep -c 'outside your project directory')" "1"
ln -s "$APPDIR" "$WORK/link-app"
OUT=$(run_err --dir "$WORK/link-app" || true)
check "symlinked dir refused" "$(printf '%s' "$OUT" | grep -c 'symbolic link')" "1"
ln -s "$WORK/timer.html" "$WORK/link.html"
OUT=$(run_err --html "$WORK/link.html" || true)
check "symlinked html refused" "$(printf '%s' "$OUT" | grep -c 'symbolic link')" "1"
mkdir -p "$WORK/home/.crewly/cloud"; printf '<p>c</p>' > "$WORK/home/.crewly/cloud/index.html"
OUT=$(env "${ENVS[@]}" CREWLY_PROJECT_PATH="$WORK/home" bash "$EXEC" --dir "$WORK/home/.crewly/cloud" 2>&1 >/dev/null || true)
check "Crewly home refused even inside the project" "$(printf '%s' "$OUT" | grep -c "inside Crewly's home")" "1"
ln -s "$OUTSIDE/index.html" "$APPDIR/escape.html"
run --dir "$APPDIR" >/dev/null
check "symlinks inside the bundle are not followed" "$(jq -c '[.body.files[].path]' "$STUB_LOG")" '["index.html","js/app.js"]'
rm -rf "$OUTSIDE"

OUT=$(run --app 28au74d9cj --rollback 2)
check "rollback: output" "$OUT" '{"success":true,"appId":"28au74d9cj","url":"https://apps.crewlyai.com/28au74d9cj","currentVersion":2}'
check "rollback: request" "$(jq -c '{path, body}' "$STUB_LOG")" '{"path":"/api/apps/28au74d9cj/rollback","body":{"version":2}}'

OUT=$(run --app 28au74d9cj --versions)
check "versions" "$OUT" '{"success":true,"versions":[{"version":2,"current":true,"note":null,"files":1,"totalBytes":9,"createdAt":"t"}]}'
OUT=$(run --list)
check "list hides deleted" "$OUT" '{"success":true,"apps":[{"appId":"a","name":"A","url":"u","agent":"s","currentVersion":1,"source":"/x"}]}'

OUT=$(run --dir "$APPDIR" --name nologin; true)
check "backend error mapped" "$OUT" '{"success":false,"status":409,"reason":"not_logged_in","message":"not signed in","hint":"crewly cloud login"}'

# --- P3: signed links, link management, public requests -----------------------
OUT=$(run --app 28au74d9cj --share --ttl-days 14)
check "share: output never carries the signed link" "$OUT" '{"success":true,"appId":"28au74d9cj","url":"https://apps.crewlyai.com/28au74d9cj","visibility":"private","publicRequestPending":false,"notified":true,"card":"signed","cardPlace":"owner-dm","linkId":"lnk_2","linkExpiresAt":"e"}'
check "share: request" "$(jq -c '{method, path, body}' "$STUB_LOG")" '{"method":"POST","path":"/api/apps/28au74d9cj/share","body":{"ttlDays":14}}'
OUT=$(run_err --app 28au74d9cj --share --ttl-days 31 || true)
check "share: ttl out of range refused" "$(printf '%s' "$OUT" | grep -c 'ttl-days must be 1-30')" "1"
OUT=$(run_err --share || true)
check "share: needs --app" "$(printf '%s' "$OUT" | grep -c 'app <appId> is required')" "1"

OUT=$(run --app 28au74d9cj --links)
check "links: listed without urls" "$OUT" '{"success":true,"links":[{"linkId":"lnk_1","active":true,"uses":2,"createdAt":"c","expiresAt":"e","lastUsedAt":null,"revokedAt":null,"createdBy":"dev-ella"}]}'
OUT=$(run --app 28au74d9cj --revoke-link lnk_1)
check "revoke-link" "$OUT" '{"success":true,"linkId":"lnk_1","revoked":true}'
check "revoke-link: request" "$(jq -c '{method, path}' "$STUB_LOG")" '{"method":"DELETE","path":"/api/apps/28au74d9cj/links/lnk_1"}'
OUT=$(run --app 28au74d9cj --revoke-link nope; true)
check "revoke-link: unknown link" "$(printf '%s' "$OUT" | jq -c '{success, reason}')" '{"success":false,"reason":"not_found"}'
OUT=$(run_err --app 28au74d9cj --revoke-link '../x' || true)
check "revoke-link: bad id refused" "$(printf '%s' "$OUT" | grep -c 'link id')" "1"
OUT=$(run --app 28au74d9cj --revoke-links)
check "revoke-links" "$OUT" '{"success":true,"revoked":3}'
check "revoke-links: request" "$(jq -c '{method, path}' "$STUB_LOG")" '{"method":"DELETE","path":"/api/apps/28au74d9cj/links"}'

OUT=$(run --app 28au74d9cj --public --public-read "items, stats,items" --public-submit votes --public-note "class poll")
check "public request: output says the owner approves" "$OUT" '{"success":true,"appId":"28au74d9cj","url":"https://apps.crewlyai.com/28au74d9cj","requested":true,"message":"Requested: the owner approves it by opening the app. It stays private until they do; you cannot make it public yourself.","visibility":"private","publicRequest":{"publicRead":["items","stats"],"publicSubmit":["votes"],"note":"class poll"},"notified":true,"card":"signed","cardPlace":"owner-dm","linkId":"lnk_3"}'
check "public request: body" "$(jq -c '{path, body}' "$STUB_LOG")" '{"path":"/api/apps/28au74d9cj/visibility-request","body":{"publicRead":["items","stats"],"publicSubmit":["votes"],"note":"class poll"}}'
OUT=$(run_err --app 28au74d9cj --public || true)
check "public request: needs collections" "$(printf '%s' "$OUT" | grep -c 'public-read and/or --public-submit')" "1"
OUT=$(run_err --app 28au74d9cj --public-read 'bad.name' || true)
check "public request: bad collection refused" "$(printf '%s' "$OUT" | grep -c 'is not a collection name')" "1"
MANY=$(seq -s, 1 21 | sed 's/\([0-9]*\)/c\1/g')
OUT=$(run_err --app 28au74d9cj --public-submit "$MANY" || true)
check "public request: at most 20" "$(printf '%s' "$OUT" | grep -c 'at most 20')" "1"

run --dir "$APPDIR" --public-read items >/dev/null
check "publish + public: request in the publish body" "$(jq -c '{publicRequest: .body.publicRequest, notify: (.body.notify // false)}' "$STUB_LOG")" '{"publicRequest":{"publicRead":["items"],"publicSubmit":[]},"notify":false}'
OUT=$(run --dir "$APPDIR" --public-read items)
check "publish + public: output" "$(printf '%s' "$OUT" | jq -c '{publicRequested, message, card}')" '{"publicRequested":true,"message":"Requested: the owner approves it by opening the app. It stays private until they do; you cannot make it public yourself.","card":"signed"}'
OUT=$(run --dir "$APPDIR" --public-read items --public-note fail)
check "publish + public: soft failure" "$(printf '%s' "$OUT" | jq -c '{success, publicRequested, publicError}')" '{"success":true,"publicRequested":false,"publicError":"old cloud"}'

OUT=$(run --app 28au74d9cj --cancel-public)
check "cancel-public" "$OUT" '{"success":true,"appId":"28au74d9cj","cancelled":true,"visibility":"private"}'
check "cancel-public: request" "$(jq -c '{method, path}' "$STUB_LOG")" '{"method":"DELETE","path":"/api/apps/28au74d9cj/visibility-request"}'
OUT=$(run --app 28au74d9cj --private)
check "private" "$OUT" '{"success":true,"appId":"28au74d9cj","visibility":"private"}'
check "private: request" "$(jq -c '{method, path}' "$STUB_LOG")" '{"method":"POST","path":"/api/apps/28au74d9cj/make-private"}'
OUT=$(run_err --app 28au74d9cj --share --links || true)
check "one action at a time" "$(printf '%s' "$OUT" | grep -c 'at a time')" "1"
OUT=$(run_err --dir "$APPDIR" --private || true)
check "--private is not a publish option" "$(printf '%s' "$OUT" | grep -c 'act on an app')" "1"

echo "publish-app: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
