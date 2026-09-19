#!/bin/bash
# Tests for drive-upload — run with: bash execute.test.sh
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

PORT=18812
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
        self.wfile.write(json.dumps({'success': True, 'data': {'id': 'u1', 'name': data.get('name'), 'mimeType': data.get('convertTo') or data.get('mimeType'), 'webViewLink': 'https://v'}}).encode())
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

TMP="$(mktemp).md"; printf 'hello' > "$TMP"
OUT=$(run --path "$TMP" --folder f1 --convert doc)
check "file: output" "$OUT" "{\"success\":true,\"file\":{\"id\":\"u1\",\"name\":\"$(basename "$TMP")\",\"mimeType\":\"application/vnd.google-apps.document\",\"webViewLink\":\"https://v\"}}"
check "file: body" "$(jq -c '.body' "$STUB_LOG")" "{\"name\":\"$(basename "$TMP")\",\"content\":\"hello\",\"encoding\":\"utf8\",\"mimeType\":\"text/markdown\",\"folderId\":\"f1\",\"convertTo\":\"application/vnd.google-apps.document\"}"
rm -f "$TMP"
BIN="$(mktemp).png"; printf '\x89PNG\x00' > "$BIN"
run --path "$BIN" >/dev/null
check "binary: base64" "$(jq -r '.body.encoding + " " + .body.content + " " + .body.mimeType' "$STUB_LOG")" "base64 iVBORwA= image/png"
rm -f "$BIN"
run --name a.txt --text "plain" >/dev/null
check "text: body" "$(jq -c '.body' "$STUB_LOG")" '{"name":"a.txt","content":"plain","encoding":"utf8","mimeType":"text/plain"}'
check "text: path" "$(jq -r .path "$STUB_LOG")" "/api/google/drive/files"

echo "drive-upload: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
