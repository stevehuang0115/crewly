#!/bin/bash
# Validation tests for schedule-followup skill.
# End-to-end behaviour (actually POSTing to /api/triggers) is verified by the
# backend integration tests; here we cover argument parsing + guard rails.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${test_name}"
    echo "    expected to contain: ${needle}"
    echo "    got: ${haystack}"
  fi
}

echo "=== schedule-followup tests ==="

echo ""
echo "--- Required args ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --in-minutes 30 2>&1) || true
assert_contains "Missing --title rejected" "title is required" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --title "Check Rex" 2>&1) || true
assert_contains "No timing spec rejected" "one of --in-minutes" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --title "Check" --in-minutes 30 --fire-at "2026-01-01T00:00:00Z" 2>&1) || true
assert_contains "Conflicting timing specs rejected" "one of --in-minutes" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --title "Check" --cron "0 * * * *" --for-work-item wi-1 2>&1) || true
assert_contains "--for-work-item refused with --cron" "for-work-item needs --in-minutes or --fire-at" "$OUTPUT"

# What is sent: run against a stub that records the request body.
STUB_DIR=$(mktemp -d)
python3 - "$STUB_DIR" <<'PY' &
import sys, http.server
d = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        open(d + '/body', 'wb').write(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(201); self.end_headers(); self.wfile.write(b'{"success":true}')
    def log_message(self, *a): pass
s = http.server.HTTPServer(('127.0.0.1', 0), H)
open(d + '/port', 'w').write(str(s.server_port))
s.serve_forever()
PY
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null; wait $STUB_PID 2>/dev/null || true; rm -rf "$STUB_DIR"' EXIT
for _ in $(seq 1 50); do [ -s "$STUB_DIR/port" ] && break; sleep 0.1; done
send() {
  rm -f "$STUB_DIR/body"
  CREWLY_API_URL="http://127.0.0.1:$(cat "$STUB_DIR/port")" CREWLY_SESSION_NAME=tester bash "$SCRIPT_DIR/execute.sh" "$@" >/dev/null 2>&1 || true
  cat "$STUB_DIR/body" 2>/dev/null || true
}
assert_contains "--for-work-item is sent" '"forWorkItemId": *"wi-1"' "$(send --in-minutes 30 --title "Recheck" --for-work-item wi-1)"
assert_contains "JSON forWorkItemId is sent" '"forWorkItemId": *"wi-2"' "$(send '{"inMinutes":30,"title":"Recheck","forWorkItemId":"wi-2"}')"
if send --in-minutes 30 --title "Recheck" | grep -q forWorkItemId; then
  FAIL=$((FAIL + 1)); echo "  ✗ no forWorkItemId unless asked"
else
  PASS=$((PASS + 1)); echo "  ✓ no forWorkItemId unless asked"
fi

echo ""
echo "--- Help ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --help 2>&1) || true
assert_contains "Help lists --in-minutes" -- "--in-minutes" "$OUTPUT"
assert_contains "Help lists --fire-at" -- "--fire-at" "$OUTPUT"
assert_contains "Help lists --cron" -- "--cron" "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
