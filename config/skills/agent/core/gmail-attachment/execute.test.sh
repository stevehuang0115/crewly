#!/bin/bash
# Tests for gmail-attachment — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts requests, saved bytes and JSON output.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi
}

PORT=18821
WORK="$(mktemp -d)"; STUB_LOG="$WORK/log"; export STUB_LOG STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os, base64
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
MSG = {'id': 'm1', 'attachments': [
  {'filename': 'deck.pdf', 'mimeType': 'application/pdf', 'size': 6, 'attachmentId': 'A1'},
  {'filename': 'pic.png', 'mimeType': 'image/png', 'size': 6, 'attachmentId': 'A2'},
  {'filename': 'huge.zip', 'mimeType': 'application/zip', 'size': 30000000, 'attachmentId': 'A3'}]}
DATA = bytes([0x25, 0x50, 0x44, 0x46, 0xff, 0x00])
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        open(LOG, 'a').write(self.path + '\n')
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        if '/attachments/' in self.path:
            self.wfile.write(json.dumps({'success': True, 'data': {'messageId': 'm1', 'attachmentId': 'x', 'size': 6, 'dataBase64': base64.b64encode(DATA).decode()}}).encode())
        else:
            self.wfile.write(json.dumps({'success': True, 'data': MSG}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

export CREWLY_HOME="$WORK/home" CREWLY_SESSION_NAME=test
run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }

: > "$STUB_LOG"
# By filename, no pdftotext on PATH: path only, bytes intact.
NOPDF="$WORK/nopdf"; mkdir -p "$NOPDF"; for t in bash jq curl python3 dirname mkdir tr sed wc base64 mv rm cat date find head tail grep awk cut sort uname od; do ln -sf "$(command -v $t)" "$NOPDF/$t"; done
OUT=$(PATH="$NOPDF" CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --message m1 --attachment deck.pdf 2>/dev/null)
EXPECT_PATH="$WORK/home/attachments/m1/deck.pdf"
check "by filename: path" "$(printf '%s' "$OUT" | jq -r .path)" "$EXPECT_PATH"
check "by filename: no text without pdftotext" "$(printf '%s' "$OUT" | jq -r 'has("text")')" "false"
check "by filename: bytes intact" "$(od -An -tx1 "$EXPECT_PATH" | tr -d ' \n')" "25504446ff00"
check "by filename: size" "$(printf '%s' "$OUT" | jq -r .size)" "6"
check "by filename: requests" "$(tr '\n' ' ' < "$STUB_LOG")" "/api/google/gmail/messages/m1 /api/google/gmail/messages/m1/attachments/A1 "

# By id with --out, with a fake pdftotext: text is printed.
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
printf '#!/bin/bash\necho "Hello from the PDF"\n' > "$FAKEBIN/pdftotext"; chmod +x "$FAKEBIN/pdftotext"
OUT=$(PATH="$FAKEBIN:$PATH" run '{"message":"m1","attachment":"A1","out":"'"$WORK"'/custom/x.pdf"}')
check "by id + out: path" "$(printf '%s' "$OUT" | jq -r .path)" "$WORK/custom/x.pdf"
check "pdf: extracted text" "$(printf '%s' "$OUT" | jq -r .text)" "Hello from the PDF"

# Non-PDF never gets text even with pdftotext available.
OUT=$(PATH="$FAKEBIN:$PATH" run --message m1 --attachment A2)
check "png: no text" "$(printf '%s' "$OUT" | jq -r 'has("text")')" "false"
check "png: success" "$(printf '%s' "$OUT" | jq -r .success)" "true"

# Unknown attachment and over-cap attachment are refused before any download.
: > "$STUB_LOG"
OUT=$(run --message m1 --attachment nope.txt); RC=$?
check "unknown: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "not_found"
OUT=$(run --message m1 --attachment huge.zip)
check "too large: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "too_large"
check "refusals download nothing" "$(grep -c attachments/ "$STUB_LOG")" "0"

echo "gmail-attachment: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
