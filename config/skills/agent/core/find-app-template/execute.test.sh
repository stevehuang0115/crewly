#!/bin/bash
# Tests for find-app-template — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the request and the JSON printed.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18851
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        open(LOG, 'w').write(json.dumps({'path': u.path, 'query': {k: v[0] for k, v in q.items()}, 'session': self.headers.get('X-Agent-Session')}))
        def send(code, obj):
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(obj).encode())
        if q.get('q', [''])[0] == 'offline':
            return send(409, {'success': False, 'error': 'not_logged_in', 'message': 'This machine is not signed in to Crewly Cloud.'})
        if q.get('q', [''])[0] == 'nothing':
            return send(200, {'success': True, 'data': {'templates': [], 'total': 0}})
        send(200, {'success': True, 'data': {'total': 1, 'templates': [{'templateId': 'tpl-k3m9p2x7aq', 'name': 'Chore chart', 'description': 'Kids chores', 'category': 'family',
            'tags': ['chores'], 'author': 'Steve', 'installs': 12, 'version': 3, 'capabilities': [], 'previewUrl': 'https://apps.crewlyai.com/_t/tpl-k3m9p2x7aq',
            'thumbnailUrl': None, 'listedAt': 'x'}]}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
WORK="$(mktemp -d)"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done
mkdir -p "$WORK/home/.crewly"
ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly")
run() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

OUT=$(run --query "chore chart for kids" --tag chores --category family --limit 3)
check "request" "$(jq -c '{path, query, session}' "$STUB_LOG")" '{"path":"/api/apps/templates","query":{"q":"chore chart for kids","limit":"3","tag":"chores","category":"family"},"session":"dev-ella"}'
check "output" "$OUT" '{"success":true,"query":"chore chart for kids","total":1,"next":"Look at the best match (previewUrl). If it fits, run use-app-template tpl-k3m9p2x7aq --dir ./<dir> and adapt it; tell the owner in one line which template you started from. If none fits, build the app with publish-app.","templates":[{"templateId":"tpl-k3m9p2x7aq","name":"Chore chart","description":"Kids chores","category":"family","tags":["chores"],"author":"Steve","installs":12,"version":3,"capabilities":[],"previewUrl":"https://apps.crewlyai.com/_t/tpl-k3m9p2x7aq"}]}'

run "habit tracker" >/dev/null
check "positional query, default limit 5" "$(jq -c '.query' "$STUB_LOG")" '{"q":"habit tracker","limit":"5"}'
run '{"query":"poll","limit":2}' >/dev/null
check "JSON input" "$(jq -c '.query' "$STUB_LOG")" '{"q":"poll","limit":"2"}'

OUT=$(run --query nothing)
check "no match says build it yourself" "$(printf '%s' "$OUT" | jq -c '{total, next, templates}')" '{"total":0,"next":"No template matches. Build the app yourself with publish-app.","templates":[]}'

OUT=$(run --query offline; true)
check "backend error mapped" "$OUT" '{"success":false,"reason":"not_logged_in","message":"This machine is not signed in to Crewly Cloud."}'

check "query required" "$(run_err | grep -c 'query')" "1"
check "bad tag refused" "$(run_err --query x --tag 'Two Words' | grep -c 'one lower-case word')" "1"
check "bad limit refused" "$(run_err --query x --limit lots | grep -c 'must be a number')" "1"

echo "find-app-template: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
