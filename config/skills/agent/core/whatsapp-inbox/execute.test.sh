#!/bin/bash
# Tests for whatsapp-inbox — run with: bash execute.test.sh </dev/null
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

PORT=18841
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
ENTRY = {'chat': {'id': '491@s.whatsapp.net', 'name': 'Ann', 'isGroup': False, 'lastMessageAt': 1760000000000},
         'unansweredCount': 2, 'lastText': 'x' * 300, 'lastKind': 'text', 'lastSenderName': 'Ann', 'lastMessageAt': 1760000000000}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        open(LOG, 'w').write(json.dumps({'method': 'GET', 'path': self.path, 'agent': self.headers.get('X-Agent-Session')}))
        qs = parse_qs(urlparse(self.path).query)
        if qs.get('limit', [''])[0] == '999':
            self.send_response(500); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'db locked'}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': [ENTRY]}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

X200=$(printf 'x%.0s' $(seq 1 200))
WANT='{"count":1,"chats":[{"chatId":"491@s.whatsapp.net","name":"Ann","isGroup":false,"unanswered":2,"lastKind":"text","lastFrom":"Ann","lastText":"'"$X200"'","lastAt":"2025-10-09T08:53:20Z"}]}'

OUT=$(run)
check "defaults: output (preview truncated to 200)" "$OUT" "$WANT"
check "defaults: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/inbox"
check "sends the agent session header" "$(jq -r .agent "$STUB_LOG")" "test-agent"

run --limit 5 --include-groups >/dev/null
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/inbox?limit=5&includeGroups=true"

run '{"limit":7,"includeGroups":true}' >/dev/null
check "json: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/inbox?limit=7&includeGroups=true"

run --include-groups >/dev/null
check "groups only: path" "$(jq -r .path "$STUB_LOG")" "/api/whatsapp/inbox?includeGroups=true"

OUT=$(CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --limit 999 2>/dev/null); RC=$?
check "500: exit code" "$RC" "1"
check "500: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "db locked"

check "unknown option errors" "$(run_err --bogus)" "Unknown option: --bogus"
check "--limit needs a value" "$(run_err --limit)" "--limit requires a value"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
