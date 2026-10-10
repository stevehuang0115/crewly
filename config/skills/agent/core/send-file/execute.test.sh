#!/bin/bash
# Tests for send-file — run with: bash execute.test.sh
# A Python stub plays both the Crewly backend and the object storage.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi; }

PORT=18861
STUB_LOG="$(mktemp)"; STORE="$(mktemp)"; export STUB_LOG STORE STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; STORE = os.environ['STORE']; PORT = int(os.environ['STUB_PORT'])
ID = 'hf_AbCdEfGhIjKlMnOpQrStUv'
def note(**kw):
    with open(LOG, 'a') as f: f.write(json.dumps(kw) + '\n')
class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(obj).encode())
    def body(self):
        n = int(self.headers.get('Content-Length') or 0); return self.rfile.read(n)
    def do_POST(self):
        b = self.body()
        if self.path == '/api/apps/handoffs':
            req = json.loads(b); note(op='create', req=req, session=self.headers.get('X-Agent-Session'))
            if req['fileName'] == 'refuse.bin':
                return self.send(402, {'success': False, 'error': 'quota_exceeded', 'message': 'Too many bytes waiting.'})
            return self.send(201, {'success': True, 'data': {'handoffId': ID, 'status': 'pending', 'upload': {'url': f'http://127.0.0.1:{PORT}/store/obj', 'method': 'PUT', 'headers': {'Content-Type': req['contentType'], 'x-amz-server-side-encryption': 'AES256'}}}})
        if self.path == f'/api/apps/handoffs/{ID}/complete':
            note(op='complete'); return self.send(200, {'success': True, 'data': {'handoffId': ID, 'status': 'ready', 'expiresAt': '2026-10-10T00:00:00.000Z'}})
        self.send(404, {'success': False})
    def do_DELETE(self):
        note(op='cancel', path=self.path); self.send(200, {'success': True, 'data': {'deleted': True}})
    def do_PUT(self):
        b = self.body()
        note(op='put', bytes=len(b), ctype=self.headers.get('Content-Type'), sse=self.headers.get('x-amz-server-side-encryption'))
        self.send_response(500 if os.path.exists(STORE + '.fail') else 200); self.end_headers()
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
WORK="$(mktemp -d)"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$STORE" "$STORE.fail" "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done
mkdir -p "$WORK/home/.crewly" "$WORK/proj"
ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly" CREWLY_PROJECT_PATH="$WORK/proj")
run() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

head -c 3000000 /dev/zero > "$WORK/proj/daily.mp4"
OUT=$(run --path "$WORK/proj/daily.mp4" --note "today" --to Mia)
check "result" "$(printf '%s' "$OUT" | jq -c '{success, handoffId, fileName, sizeBytes, expiresAt}')" '{"success":true,"handoffId":"hf_AbCdEfGhIjKlMnOpQrStUv","fileName":"daily.mp4","sizeBytes":3000000,"expiresAt":"2026-10-10T00:00:00.000Z"}'
check "instruction names the receiver skill" "$(printf '%s' "$OUT" | jq -r '.instruction' | grep -c 'receive-file/execute.sh --id hf_AbCdEfGhIjKlMnOpQrStUv')" "1"
check "create request" "$(sed -n 1p "$STUB_LOG" | jq -c '{req, session}')" '{"req":{"fileName":"daily.mp4","sizeBytes":3000000,"contentType":"video/mp4","note":"today","to":"Mia"},"session":"dev-ella"}'
check "upload streamed with signed headers" "$(sed -n 2p "$STUB_LOG" | jq -c '{bytes, ctype, sse}')" '{"bytes":3000000,"ctype":"video/mp4","sse":"AES256"}'
check "complete called" "$(sed -n 3p "$STUB_LOG" | jq -r .op)" "complete"

: > "$STUB_LOG"
OUT=$(run --path "$WORK/proj/daily.mp4" --name "refuse.bin"; true)
check "cloud refusal passed through" "$(printf '%s' "$OUT" | jq -c '{success, reason}')" '{"success":false,"reason":"quota_exceeded"}'

: > "$STUB_LOG"; touch "$STORE.fail"
OUT=$(run --path "$WORK/proj/daily.mp4"; true)
check "failed upload reports and cancels" "$(printf '%s' "$OUT" | jq -r .reason)" "upload_failed"
check "cancel issued" "$(grep -c '"op": "cancel"' "$STUB_LOG")" "1"
rm -f "$STORE.fail"

echo secret > "$WORK/outside.txt"; ln -s "$WORK/proj/daily.mp4" "$WORK/proj/link.mp4"
check "outside project refused" "$(run_err --path "$WORK/outside.txt" | grep -c 'outside your project directory')" "1"
check "symlink refused" "$(run_err --path "$WORK/proj/link.mp4" | grep -c 'symbolic link')" "1"
check "missing file refused" "$(run_err --path "$WORK/proj/nope" | grep -c 'file not found')" "1"
check "path required" "$(run_err | grep -c -- '--path is required')" "1"
: > "$STUB_LOG"
run --cancel hf_AbCdEfGhIjKlMnOpQrStUv >/dev/null
check "cancel" "$(jq -r .path "$STUB_LOG")" "/api/apps/handoffs/hf_AbCdEfGhIjKlMnOpQrStUv"

echo "send-file: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
