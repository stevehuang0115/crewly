#!/bin/bash
# Tests for calendar-list — run with: bash execute.test.sh
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

PORT=18804
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
EV = {'id': 'e1', 'summary': 'Standup', 'start': {'dateTime': '2026-09-18T09:00:00Z'}, 'end': {'dateTime': '2026-09-18T09:15:00Z'}, 'attendees': []}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        open(LOG, 'w').write(json.dumps({'method': 'GET', 'path': self.path}))
        qs = parse_qs(urlparse(self.path).query)
        if qs.get('calendarId', [''])[0] == 'no-grant':
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'count': 1, 'events': [EV]}}).encode())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

WANT='{"count":1,"events":[{"id":"e1","summary":"Standup","start":{"dateTime":"2026-09-18T09:00:00Z"},"end":{"dateTime":"2026-09-18T09:15:00Z"},"attendees":[]}]}'

OUT=$(run --from 2026-09-18T00:00:00Z --to 2026-09-19T00:00:00Z --calendar "team@group.calendar.google.com" --max 20)
check "flags: output" "$OUT" "$WANT"
check "flags: path" "$(jq -r .path "$STUB_LOG")" "/api/google/calendar/events?from=2026-09-18T00%3A00%3A00Z&to=2026-09-19T00%3A00%3A00Z&calendarId=team%40group.calendar.google.com&max=20"

OUT=$(run '{"from":"2026-09-18T00:00:00Z","to":"2026-09-19T00:00:00Z"}')
check "json: output" "$OUT" "$WANT"
check "json: path without optional params" "$(jq -r .path "$STUB_LOG")" "/api/google/calendar/events?from=2026-09-18T00%3A00%3A00Z&to=2026-09-19T00%3A00%3A00Z"

# --- defaults: now → now + 7 days (shape only; values are wall-clock) ---
run >/dev/null
P=$(jq -r .path "$STUB_LOG")
FROM_V=$(printf '%s' "$P" | sed -E 's/.*[?&]from=([^&]*).*/\1/')
TO_V=$(printf '%s' "$P" | sed -E 's/.*[?&]to=([^&]*).*/\1/')
[[ "$FROM_V" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}%3A[0-9]{2}%3A[0-9]{2}Z$ ]] && FROM_OK=yes || FROM_OK=no
[[ "$TO_V" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}%3A[0-9]{2}%3A[0-9]{2}Z$ ]] && TO_OK=yes || TO_OK=no
check "defaults: from is ISO UTC" "$FROM_OK" "yes"
check "defaults: to is ISO UTC" "$TO_OK" "yes"
[ "$TO_V" \> "$FROM_V" ] && ORDER=yes || ORDER=no
check "defaults: to is after from" "$ORDER" "yes"

OUT=$(CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" --calendar no-grant 2>/dev/null); RC=$?
check "409: exit code" "$RC" "1"
check "409: reason + hint" "$OUT" '{"success":false,"reason":"not_connected","hint":"https://cloud/start?token=j","message":"no grant"}'

check "unknown option errors" "$(run_err --bogus 1)" "Unknown option: --bogus"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
