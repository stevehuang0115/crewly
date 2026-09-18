#!/bin/bash
# Tests for gmail-send — run with: bash execute.test.sh
# Spins up a python HTTP stub as the backend, asserts the request body the
# skill sends, the JSON it prints, and that dry-run makes NO request.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18803
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        data = json.loads(body or '{}')
        open(LOG, 'w').write(json.dumps({'method': 'POST', 'path': self.path, 'body': data}))
        if data.get('to') == 'no-grant@example.com':
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'id': 's1', 'threadId': data.get('threadId', 'tNew'), 'labelIds': ['SENT']}}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_GMAIL_SEND_DRY_RUN="" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_GMAIL_SEND_DRY_RUN="" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

# --- send with all fields ---
OUT=$(run --to ann@example.com --cc bob@example.com --subject "Re: 第三季度" --text "Looks good" --thread-id t1 --in-reply-to "<abc@x>")
check "send: output" "$OUT" '{"success":true,"id":"s1","threadId":"t1"}'
check "send: path" "$(jq -r .path "$STUB_LOG")" "/api/google/gmail/send"
check "send: body" "$(jq -c .body "$STUB_LOG")" '{"to":"ann@example.com","subject":"Re: 第三季度","text":"Looks good","cc":"bob@example.com","threadId":"t1","inReplyTo":"<abc@x>"}'

# --- minimal + JSON input + text file ---
TMP=$(mktemp); printf 'line one\nline two' > "$TMP"
OUT=$(run '{"to":"a@b.c","subject":"Hi"}' --text-file "$TMP"); rm -f "$TMP"
check "json+file: output" "$OUT" '{"success":true,"id":"s1","threadId":"tNew"}'
check "json+file: body omits optional keys" "$(jq -c .body "$STUB_LOG")" '{"to":"a@b.c","subject":"Hi","text":"line one\nline two"}'

# --- dry run via env: no request, preview printed ---
: > "$STUB_LOG"
OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_GMAIL_SEND_DRY_RUN=1 bash "$EXEC" --to a@b.c --cc c@d.e --subject "Hi" --text "hello" --in-reply-to "<m@x>" 2>/dev/null); RC=$?
check "env dry-run: exit 0" "$RC" "0"
check "env dry-run: preview" "$OUT" '{"success":true,"dryRun":true,"preview":"To: a@b.c\nCc: c@d.e\nSubject: Hi\nIn-Reply-To: <m@x>\n\nhello"}'
check "env dry-run: no request made" "$(cat "$STUB_LOG")" ""

# --- dry run via flag ---
OUT=$(run --to a@b.c --subject "Hi" --text "x" --dry-run)
check "flag dry-run: preview" "$OUT" '{"success":true,"dryRun":true,"preview":"To: a@b.c\nSubject: Hi\n\nx"}'
check "flag dry-run: no request made" "$(cat "$STUB_LOG")" ""

# --- dry run still validates ---
check "dry-run without --to refuses" "$(CREWLY_GMAIL_SEND_DRY_RUN=1 run_err --subject Hi --text x)" "Missing required parameter: to (--to)"

# --- backend 409 ---
OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_GMAIL_SEND_DRY_RUN="" bash "$EXEC" --to no-grant@example.com --subject Hi --text x 2>/dev/null); RC=$?
check "409: exit code" "$RC" "1"
check "409: reason + hint" "$OUT" '{"success":false,"reason":"not_connected","hint":"https://cloud/start?token=j","message":"no grant"}'

# --- validation (nothing sent) ---
: > "$STUB_LOG"
check "missing to errors" "$(run_err --subject Hi --text x)" "Missing required parameter: to (--to)"
check "missing subject errors" "$(run_err --to a@b.c --text x)" "Missing required parameter: subject (--subject)"
check "missing text errors" "$(run_err --to a@b.c --subject Hi)" "Missing required parameter: text (--text or --text-file)"
check "missing text file errors" "$(run_err --to a@b.c --subject Hi --text-file /nonexistent/x.txt)" "text file not found: /nonexistent/x.txt"
check "validation: no request made" "$(cat "$STUB_LOG")" ""
check "unknown option errors" "$(run_err --bogus 1)" "Unknown option: --bogus"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
