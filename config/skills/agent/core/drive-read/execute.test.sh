#!/bin/bash
# Tests for drive-read — run with: bash execute.test.sh
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

PORT=18811
STUB_LOG="$(mktemp)"; export STUB_LOG; BIG_PATH="$(mktemp)"; export BIG_PATH; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os, base64, random
BIG = random.Random(7).randbytes(300 * 1024)
open(os.environ['BIG_PATH'], 'wb').write(BIG)
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        open(LOG, 'w').write(json.dumps({'method': method, 'path': self.path, 'body': data}))
        if 'no-grant' in self.path or (data or {}).get('title') == 'no-grant':
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        if 'bigfile' in self.path:
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': True, 'data': {'file': {'id': 'big', 'name': 'a.png', 'mimeType': 'image/png'}, 'contentType': 'image/png', 'encoding': 'base64', 'bytes': len(BIG), 'content': base64.b64encode(BIG).decode()}}).encode()); return
        if 'nocontent' in self.path:
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': True, 'data': {'file': {'id': 'n'}}}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'file': {'id': 'f1', 'name': 'a.txt', 'mimeType': 'text/plain'}, 'contentType': 'text/plain', 'encoding': 'utf8', 'bytes': 2, 'content': 'hi'}}).encode())
    def do_GET(self): self._reply('GET')
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        self._reply('POST', json.loads(body or '{}'))
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG" "$BIG_PATH"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

OUT=$(run --id "f 1")
check "flags: output" "$OUT" '{"file":{"id":"f1","name":"a.txt","mimeType":"text/plain"},"contentType":"text/plain","encoding":"utf8","bytes":2,"content":"hi"}'
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/google/drive/files/f%201/content"
TMP=$(mktemp)
OUT=$(run '{"id":"f1"}' --out "$TMP")
check "out: saved" "$(cat "$TMP")" "hi"
check "out: metadata" "$OUT" "{\"file\":{\"id\":\"f1\",\"name\":\"a.txt\",\"mimeType\":\"text/plain\"},\"contentType\":\"text/plain\",\"bytes\":2,\"savedTo\":\"$TMP\"}"
rm -f "$TMP"
OUT=$(run_err || true)
check "missing id fails" "$(printf '%s' "$OUT" | grep -c 'id')" "1"

# A >=200 KB binary is larger than the skill output cap: --out must still save the exact bytes.
for i in $(seq 1 30); do [ -s "$BIG_PATH" ] && break; sleep 0.1; done
BIGOUT=$(mktemp)
OUT=$(run --id bigfile --out "$BIGOUT")
check "big --out: bytes match" "$(shasum -a 256 < "$BIGOUT" | cut -d' ' -f1)" "$(shasum -a 256 < "$BIG_PATH" | cut -d' ' -f1)"
check "big --out: size >= 200KB" "$([ "$(wc -c < "$BIGOUT")" -ge 204800 ] && echo yes)" "yes"
check "big --out: summary" "$(printf '%s' "$OUT" | jq -r '.savedTo == "'"$BIGOUT"'" and (.truncated // false) == false')" "true"
rm -f "$BIGOUT"
# Without --out the cap applies: a truncated envelope that says how to get the whole file.
OUT=$(run --id bigfile)
check "big no --out: truncated" "$(printf '%s' "$OUT" | jq -r .truncated)" "true"
check "big no --out: says use --out" "$(printf '%s' "$OUT" | jq -r '.next | contains("--out")')" "true"
# --out must never report success without a file.
NOFILE=$(mktemp -u)
OUT=$(run --id nocontent --out "$NOFILE"); RC=$?
check "no content --out: fails" "$(printf '%s' "$OUT" | jq -r .reason)" "no_content"
check "no content --out: no file" "$([ -e "$NOFILE" ] && echo yes || echo no)" "no"

echo "drive-read: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
