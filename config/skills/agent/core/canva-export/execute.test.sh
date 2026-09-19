#!/bin/bash
# Tests for canva-export — run with: bash execute.test.sh
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

PORT=18822
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
        self.wfile.write(json.dumps({'success': True, 'data': {'jobId': 'J1', 'status': 'success', 'urls': ['http://127.0.0.1:%d/dl/1' % PORT]}}).encode())
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

OUT=$(run --id D1 --format pdf --pages 1,2)
check "pdf: output" "$OUT" "{\"success\":true,\"jobId\":\"J1\",\"urls\":[\"http://127.0.0.1:${PORT}/dl/1\"],\"savedTo\":[]}"
check "pdf: path+body" "$(jq -r '.path + " " + (.body|tojson)' "$STUB_LOG")" '/api/canva/designs/D1/export {"format":"pdf","pages":[1,2]}'
run '{"id":"D1","format":"jpg","quality":85}' >/dev/null
check "jpg: body" "$(jq -c .body "$STUB_LOG")" '{"format":"jpg","quality":85}'
TMP="$(mktemp).pdf"
OUT=$(run --id D1 --format pdf --out "$TMP")
check "download: saved" "$(printf '%s' "$OUT" | jq -r '.savedTo[0]')" "$TMP"
check "download: bytes" "$(cat "$TMP")" '{"success": true, "data": {"jobId": "J1", "status": "success", "urls": ["http://127.0.0.1:'"$PORT"'/dl/1"]}}'
rm -f "$TMP"

echo "canva-export: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
