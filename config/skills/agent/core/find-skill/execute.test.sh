#!/bin/bash
# Tests for find-skill — run with: bash execute.test.sh </dev/null
# A python HTTP stub plays the backend; asserts the request and the output shape.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18851
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def reply(self, code, body):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        open(LOG, 'w').write(json.dumps({'path': u.path, 'query': q, 'agent': self.headers.get('X-Agent-Session')}))
        if q.get('query', [''])[0] == 'boom':
            return self.reply(500, {'success': False, 'error': 'registry exploded'})
        self.reply(200, {'success': True, 'data': {'query': q['query'][0], 'registryAvailable': True,
            'next': 'transcribe-audio is an official skill (bundled with Crewly) that is not ready yet. Tell the user…',
            'candidates': [{'id': 'transcribe-audio', 'name': 'transcribe-audio', 'description': 'x' * 500, 'official': True,
                'officialReason': 'bundled with Crewly', 'installed': True, 'ready': False, 'tags': ['audio'], 'triggers': [],
                'setup': {'declared': True, 'estimatedMinutes': 6, 'satisfied': False, 'missing': ['whisper-cli']},
                'executePath': '/pkg/transcribe-audio/execute.sh', 'source': 'bundled', 'score': 12}]}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=test-agent CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -rs 'last.error' 2>/dev/null; }

OUT=$(run --query "transcribe a voice message (m4a)" --limit 3)
check "path" "$(jq -r .path "$STUB_LOG")" "/api/skill-setup/find"
check "query encoded + sent" "$(jq -r '.query.query[0]' "$STUB_LOG")" "transcribe a voice message (m4a)"
check "limit sent" "$(jq -r '.query.limit[0]' "$STUB_LOG")" "3"
check "agent header" "$(jq -r .agent "$STUB_LOG")" "test-agent"
check "success" "$(printf '%s' "$OUT" | jq -r .success)" "true"
check "next passed through" "$(printf '%s' "$OUT" | jq -r '.next | startswith("transcribe-audio is an official skill")')" "true"
check "candidate fields" "$(printf '%s' "$OUT" | jq -c '.candidates[0] | {id, official, ready, source, missing: .setup.missing}')" '{"id":"transcribe-audio","official":true,"ready":false,"source":"bundled","missing":["whisper-cli"]}'
check "description trimmed" "$(printf '%s' "$OUT" | jq -r '.candidates[0].description | length')" "200"
check "internal score dropped" "$(printf '%s' "$OUT" | jq -r '.candidates[0] | has("score")')" "false"

run '{"query":"语音 转文字"}' >/dev/null
check "json input" "$(jq -r '.query.query[0]' "$STUB_LOG")" "语音 转文字"

OUT=$(run --query boom); RC=$?
check "backend error: exit 1" "$RC" "1"
check "backend error: message" "$(printf '%s' "$OUT" | jq -r .error)" "registry exploded"

check "missing query" "$(run_err)" "Missing required parameter: query (--query)"
check "bad limit" "$(run_err --query x --limit lots)" "--limit must be a number"
check "unknown option" "$(run_err --install)" "Unknown option: --install"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
