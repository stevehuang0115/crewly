#!/bin/bash
# Tests for whatsapp-read — run with: bash execute.test.sh </dev/null
# Spins up a python HTTP stub as the backend, asserts the request path the
# skill sends and the JSON it prints. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18842
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
CHAT = {'id': '491@s.whatsapp.net', 'name': 'Ann', 'isGroup': False, 'lastMessageAt': 1760000000000}
M_IN = {'id': 'm1', 'chatId': '491@s.whatsapp.net', 'fromMe': False, 'senderJid': '491@s.whatsapp.net', 'senderName': 'Ann', 'text': 'at 8?', 'ts': 1760000000000, 'kind': 'text'}
M_OUT = dict(M_IN, id='m2', fromMe=True, senderJid='999@s.whatsapp.net', senderName=None, text='yes', ts=1760000060000)
class H(BaseHTTPRequestHandler):
    def reply(self, code, body):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_GET(self):
        open(LOG, 'w').write(json.dumps({'method': 'GET', 'path': self.path}))
        p = urlparse(self.path).path
        if p == '/api/whatsapp/chats/nobody%40s.whatsapp.net/messages':
            return self.reply(404, {'success': False, 'code': 'chat_not_found', 'error': 'Unknown chat: nobody@s.whatsapp.net'})
        if p.endswith('/messages'):
            return self.reply(200, {'success': True, 'data': {'chat': CHAT, 'messages': [M_IN, M_OUT], 'nextBefore': 1760000000000}})
        if p == '/api/whatsapp/search':
            return self.reply(200, {'success': True, 'data': [dict(M_IN, chatName='Ann')]})
        if p == '/api/whatsapp/chats':
            return self.reply(200, {'success': True, 'data': [CHAT, {'id': '120@g.us', 'name': None, 'isGroup': True, 'lastMessageAt': None}]})
        self.reply(404, {'success': False, 'error': 'no route'})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

# --- one chat ---
OUT=$(run --chat 491@s.whatsapp.net --limit 2 --before 1760000100000)
check "chat: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/chats/491%40s.whatsapp.net/messages?limit=2&before=1760000100000"
check "chat: output" "$OUT" '{"chat":{"chatId":"491@s.whatsapp.net","name":"Ann","isGroup":false},"messages":[{"at":"2025-10-09T08:53:20Z","fromMe":false,"sender":"Ann","kind":"text","text":"at 8?"},{"at":"2025-10-09T08:54:20Z","fromMe":true,"sender":"me","kind":"text","text":"yes"}],"nextBefore":1760000000000}'

run '{"chatId":"491@s.whatsapp.net"}' >/dev/null
check "chat json: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/chats/491%40s.whatsapp.net/messages"

# --- search ---
OUT=$(run --q "dinner & wine" --limit 5)
check "search: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/search?q=dinner%20%26%20wine&limit=5"
check "search: output" "$OUT" '{"count":1,"hits":[{"chatId":"491@s.whatsapp.net","chatName":"Ann","at":"2025-10-09T08:53:20Z","fromMe":false,"sender":"Ann","kind":"text","text":"at 8?"}]}'

# --- list chats ---
OUT=$(run --chats --q ann)
check "chats: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/chats?q=ann"
check "chats: output" "$OUT" '{"count":2,"chats":[{"chatId":"491@s.whatsapp.net","name":"Ann","isGroup":false,"lastAt":"2025-10-09T08:53:20Z"},{"chatId":"120@g.us","name":"120@g.us","isGroup":true,"lastAt":null}]}'
run '{"chats":true,"limit":3}' >/dev/null
check "chats json: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/chats?limit=3"

# --- no session name: output stays clean JSON ---
OUT=$(CREWLY_SESSION_NAME= CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --q x 2>/dev/null | jq -r .count)
check "no session: output still parses" "$OUT" "1"

# --- errors ---
OUT=$(CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --chat nobody@s.whatsapp.net 2>/dev/null); RC=$?
check "404: exit code" "$RC" "1"
check "404: reason" "$OUT" '{"success":false,"reason":"chat_not_found","message":"Unknown chat: nobody@s.whatsapp.net"}'

check "needs a mode" "$(run_err)" "Pass --chat <jid>, --q <text>, or --chats"
check "unknown option errors" "$(run_err --bogus)" "Unknown option: --bogus"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
