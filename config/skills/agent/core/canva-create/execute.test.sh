#!/bin/bash
# Tests for canva-create — run with: bash execute.test.sh
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

PORT=18821
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        open(LOG, 'w').write(json.dumps({'method': method, 'path': self.path, 'body': data}))
        if 'no-grant' in self.path or (data or {}).get('title') == 'no-grant':
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'id': 'D9', 'title': data.get('title'), 'editUrl': 'https://e'}}).encode())
    def do_GET(self): self._reply('GET')
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        self._reply('POST', json.loads(body or '{}'))
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

OUT=$(run --title "Poster" --size 1080x1350)
check "size: output" "$OUT" '{"success":true,"design":{"id":"D9","title":"Poster","editUrl":"https://e"}}'
check "size: body" "$(jq -c .body "$STUB_LOG")" '{"title":"Poster","width":1080,"height":1350}'
run --title "Deck" --preset presentation >/dev/null
check "preset: body" "$(jq -c .body "$STUB_LOG")" '{"title":"Deck","preset":"presentation"}'
run '{"assetId":"A1"}' >/dev/null
check "asset: body" "$(jq -c .body "$STUB_LOG")" '{"assetId":"A1"}'
OUT=$(run_err --title "x" || true)
check "nothing to create fails" "$(printf '%s' "$OUT" | grep -c 'give --preset')" "1"

echo "canva-create: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
