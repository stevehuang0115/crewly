#!/bin/bash
# Tests for docs-comment — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the request the skill sends and
# the JSON it prints. No Google call is made. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18831
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
COMMENT = {'id': 'c1', 'author': 'Steve', 'createdTime': 't0', 'content': 'Too long', 'quote': 'intro',
           'resolved': False, 'replies': [{'id': 'r0', 'author': 'Ella', 'createdTime': 't1', 'content': 'Trimmed'}]}
class H(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
    def _reply(self, method, data=None):
        open(LOG, 'w').write(json.dumps({'method': method, 'path': self.path, 'body': data,
                                         'account': self.headers.get('X-Google-Account')}))
        if '/docs/narrow/' in self.path:
            return self._send(403, {'success': False, 'error': 'reauth_required',
                                    'message': 'Replying to or adding comments on this document needs Google Drive edit access, which this Google account has not granted yet.',
                                    'hint': 'Ask the owner to reconnect Google Drive: run the google-connect skill with --product drive.'})
        if method == 'GET':
            return self._send(200, {'success': True, 'data': {'docId': 'd1', 'comments': [COMMENT], 'truncated': False}})
        if self.path.endswith('/replies'):
            return self._send(200, {'success': True, 'data': {'docId': 'd1', 'commentId': 'c1', 'id': 'r9', 'content': data['text']}})
        if self.path.endswith('/resolve'):
            return self._send(200, {'success': True, 'data': {'docId': 'd1', 'commentId': 'c1', 'id': 'r10', 'action': 'resolve', 'content': data.get('text', ''), 'resolved': True}})
        out = {'docId': 'd1', 'id': 'c7', 'content': data['text'], 'resolved': False, 'replies': []}
        if 'quote' in data: out['quote'] = data['quote']
        return self._send(200, {'success': True, 'data': out})
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
req() { jq -r '.method + " " + .path + " " + (.body|tojson)' "$STUB_LOG"; }

# list
OUT=$(run list --doc "https://docs.google.com/document/d/d1/edit?tab=t.0")
check "list: request" "$(req)" 'GET /api/google/docs/d1/comments null'
check "list: output" "$(printf '%s' "$OUT" | jq -c '{success, docId, count, truncated, first: .comments[0].id, quote: .comments[0].quote, replies: (.comments[0].replies|length)}')" \
  '{"success":true,"docId":"d1","count":1,"truncated":false,"first":"c1","quote":"intro","replies":1}'
run list --doc d1 --include-resolved >/dev/null
check "list: --include-resolved" "$(req)" 'GET /api/google/docs/d1/comments?includeResolved=1 null'

# reply
OUT=$(run reply --doc d1 --comment c1 --text "Fixed, see para 2")
check "reply: request" "$(req)" 'POST /api/google/docs/d1/comments/c1/replies {"text":"Fixed, see para 2"}'
check "reply: output" "$OUT" '{"success":true,"action":"reply","docId":"d1","commentId":"c1","replyId":"r9","content":"Fixed, see para 2"}'

# resolve, with and without a message
OUT=$(run resolve --doc d1 --comment c1 --text "Done")
check "resolve: request" "$(req)" 'POST /api/google/docs/d1/comments/c1/resolve {"text":"Done"}'
check "resolve: output" "$OUT" '{"success":true,"action":"resolve","docId":"d1","commentId":"c1","replyId":"r10","content":"Done","resolved":true}'
run resolve --doc d1 --comment c1 >/dev/null
check "resolve: no text" "$(req)" 'POST /api/google/docs/d1/comments/c1/resolve {}'

# add, with and without a quote
OUT=$(run add --doc d1 --text "Source?" --quote "grew 40%")
check "add: request" "$(req)" 'POST /api/google/docs/d1/comments {"text":"Source?","quote":"grew 40%"}'
check "add: output" "$OUT" '{"success":true,"action":"add","docId":"d1","commentId":"c7","content":"Source?","quote":"grew 40%"}'
run add --doc d1 --text "General" >/dev/null
check "add: no quote" "$(req)" 'POST /api/google/docs/d1/comments {"text":"General"}'

# JSON input + --account
run '{"command":"reply","doc":"d1","comment":"c1","text":"via json","account":"work@x.com"}' >/dev/null
check "json input: request" "$(req)" 'POST /api/google/docs/d1/comments/c1/replies {"text":"via json"}'
check "json input: account header" "$(jq -r '.account' "$STUB_LOG")" 'work@x.com'

# reauth_required is passed through with its English hint, exit 1
OUT=$(run reply --doc narrow --comment c1 --text "x"); CODE=$?
check "reauth: exit code" "$CODE" "1"
check "reauth: reason" "$(printf '%s' "$OUT" | jq -r '.reason')" "reauth_required"
check "reauth: hint names the one-tap path" "$(printf '%s' "$OUT" | jq -r '.hint' | grep -c 'google-connect skill with --product drive')" "1"

# argument validation (no request sent)
check "no command" "$(run_err --doc d1 | grep -c 'command is required')" "1"
check "unknown command" "$(run_err delete --doc d1 | grep -c 'Unknown command')" "1"
check "reply needs --comment" "$(run_err reply --doc d1 --text x | grep -c 'comment')" "1"
check "reply needs --text" "$(run_err reply --doc d1 --comment c1 | grep -c 'text')" "1"
check "add needs --text" "$(run_err add --doc d1 | grep -c 'text')" "1"
check "needs --doc" "$(run_err list | grep -c 'doc')" "1"

echo "docs-comment: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
