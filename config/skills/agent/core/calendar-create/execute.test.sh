#!/bin/bash
# Tests for calendar-create — run with: bash execute.test.sh
# Spins up a python HTTP stub as the backend, asserts the request body the
# skill sends and the JSON it prints. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18805
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
        if data.get('summary') == 'no-grant':
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        if data.get('start') == 'tomorrow':
            self.send_response(400); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'validation', 'message': '"start" must be YYYY-MM-DD or an ISO 8601 date-time', 'hint': 'Fix the request and retry.'}).encode()); return
        tz = data.get('timezone')
        def t(v):
            if len(v) == 10: return {'date': v}
            return {'dateTime': v, 'timeZone': tz} if tz else {'dateTime': v}
        ev = {'id': 'new1', 'summary': data['summary'], 'start': t(data['start']), 'end': t(data['end']), 'htmlLink': 'https://cal/new1',
              'attendees': [{'email': a, 'responseStatus': 'needsAction'} for a in data.get('attendees', [])], 'status': 'confirmed'}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': ev}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

# --- timed event with everything ---
OUT=$(run --summary "Design review" --start 2026-09-20T14:00:00 --end 2026-09-20T15:00:00 --timezone Asia/Shanghai \
  --description "Walk through v2" --attendee ann@example.com --attendee bob@example.com --calendar ops@example.com)
check "flags: body" "$(jq -c .body "$STUB_LOG")" '{"summary":"Design review","start":"2026-09-20T14:00:00","end":"2026-09-20T15:00:00","timezone":"Asia/Shanghai","description":"Walk through v2","calendarId":"ops@example.com","attendees":["ann@example.com","bob@example.com"]}'
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/google/calendar/events"
check "flags: output" "$OUT" '{"success":true,"id":"new1","summary":"Design review","start":{"dateTime":"2026-09-20T14:00:00","timeZone":"Asia/Shanghai"},"end":{"dateTime":"2026-09-20T15:00:00","timeZone":"Asia/Shanghai"},"htmlLink":"https://cal/new1","attendees":[{"email":"ann@example.com","responseStatus":"needsAction"},{"email":"bob@example.com","responseStatus":"needsAction"}]}'

# --- all-day via JSON, comma-separated attendees ---
OUT=$(run '{"summary":"Offsite","start":"2026-10-01","end":"2026-10-02","attendees":"a@b.c, d@e.f"}')
check "json: body omits optional keys, splits attendees" "$(jq -c .body "$STUB_LOG")" '{"summary":"Offsite","start":"2026-10-01","end":"2026-10-02","attendees":["a@b.c","d@e.f"]}'
check "json: all-day output" "$(printf '%s' "$OUT" | jq -c '{start, end}')" '{"start":{"date":"2026-10-01"},"end":{"date":"2026-10-02"}}'

# --- backend validation surfaces ---
OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --summary x --start tomorrow --end 2026-10-02 2>/dev/null); RC=$?
check "400: exit code" "$RC" "1"
check "400: reason" "$(printf '%s' "$OUT" | jq -r .reason)" "validation"

# --- 409 ---
OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --summary no-grant --start 2026-10-01 --end 2026-10-02 2>/dev/null)
check "409: reason + hint" "$OUT" '{"success":false,"reason":"not_connected","hint":"https://cloud/start?token=j","message":"no grant"}'

# --- local validation (nothing sent) ---
: > "$STUB_LOG"
check "missing summary errors" "$(run_err --start 2026-10-01 --end 2026-10-02)" "Missing required parameter: summary (--summary)"
check "missing start errors" "$(run_err --summary x --end 2026-10-02)" "Missing required parameter: start (--start)"
check "missing end errors" "$(run_err --summary x --start 2026-10-01)" "Missing required parameter: end (--end)"
check "validation: no request made" "$(cat "$STUB_LOG")" ""
check "unknown option errors" "$(run_err --bogus 1)" "Unknown option: --bogus"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
