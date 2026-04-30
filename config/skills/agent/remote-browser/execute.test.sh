#!/usr/bin/env bash
# Co-located test for remote-browser skill — covers the per-tab dispatch
# wiring added for the Crewly-in-Chrome concurrent-agent fix.
#
# Strategy: spin up a tiny Python HTTP stub on a free port, point the
# skill at it via CREWLY_API_URL, then drive scenarios. The stub records
# every request (method + path + body + headers) into a JSON log so we
# can assert exact wire shape — same pattern used by chat-v2 skill tests.
#
# Each scenario gets its own runtime dir under a per-run TMPDIR so cache
# state from one case never leaks into the next.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SCRIPT_DIR}/execute.sh"

# ---------------------------------------------------------------------------
# Stub HTTP server (Python). Logs every request to $LOG_FILE as JSONL,
# returns canned responses controlled by $RESPONSE_FILE (each line = one
# JSON response, consumed in order; empty line = use default).
# ---------------------------------------------------------------------------

start_stub_server() {
  local port="$1" log_file="$2" responses_file="$3"
  # CRITICAL: redirect python's stdio to /dev/null. Without this the surrounding
  # `STUB_PID=$(start_stub_server ...)` $() subshell waits for python's stdout
  # to close — and python never closes it — causing the test to hang on
  # scenario startup. We don't need the python's chatter, only its pid.
  PORT=$port LOG_FILE=$log_file RESPONSES=$responses_file \
    python3 -c '
import http.server, json, os, threading, time, sys

LOG = os.environ["LOG_FILE"]
RESP = os.environ["RESPONSES"]
PORT = int(os.environ["PORT"])

# Load all canned responses up front.
with open(RESP) as f:
    canned = [line.rstrip("\n") for line in f]
counter = {"i": 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n).decode("utf-8") if n else ""

    def _log(self, body):
        entry = {
            "method": self.command,
            "path": self.path,
            "body": body,
            "headers": {k: v for k, v in self.headers.items()},
        }
        with open(LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def _next_response(self):
        # Skip ambient infra paths from the queued-response slot — `_common/lib.sh`
        # auto-fires `/api/heartbeat` on every skill startup, which would burn the
        # first canned response otherwise.
        if self.path.startswith("/api/heartbeat"):
            return json.dumps({"success": True})
        i = counter["i"]
        counter["i"] += 1
        if i < len(canned) and canned[i]:
            return canned[i]
        return json.dumps({"success": True, "data": {}})

    def _is_assertable(self):
        """True if this request should be visible in the request_field log
        (i.e. not an ambient heartbeat)."""
        return not self.path.startswith("/api/heartbeat")

    def _serve(self, body):
        if self._is_assertable():
            self._log(body)
        raw = self._next_response()
        # raw format: "<status>|<json-body>"  (status is optional, default 200)
        if "|" in raw:
            status_str, payload = raw.split("|", 1)
            status = int(status_str)
        else:
            status = 200
            payload = raw
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def log_message(self, fmt, *args):  # silence default access log
        return

    def do_GET(self):
        self._serve("")

    def do_POST(self):
        self._serve(self._read_body())

server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
# Daemonize so SIGTERM cleanly kills it.
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"stub listening on :{PORT}", flush=True)
# Block forever — parent will SIGKILL.
while True:
    time.sleep(60)
' >/dev/null 2>&1 &
  echo $!
}

# Pick a free TCP port on 127.0.0.1
free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

# ---------------------------------------------------------------------------
# Test harness — minimal pass/fail printer
# ---------------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32m✓\033[0m %s\n' "$1"
}
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  \033[31m✗\033[0m %s\n' "$1"
  [ -n "${2:-}" ] && printf '      %s\n' "$2"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$label"
  else
    fail "$label" "expected=$expected actual=$actual"
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$label"
  else
    fail "$label" "needle=$needle haystack=$haystack"
  fi
}

# ---------------------------------------------------------------------------
# Per-scenario fixture: fresh stub + fresh runtime dir
# ---------------------------------------------------------------------------

scenario_init() {
  local name="$1"
  echo
  echo "=== $name ==="
  PORT=$(free_port)
  WORK_DIR=$(mktemp -d -t remote-browser-test.XXXXXX)
  LOG_FILE="${WORK_DIR}/requests.jsonl"
  RESP_FILE="${WORK_DIR}/responses.txt"
  RUNTIME_DIR="${WORK_DIR}/runtime"
  : > "$LOG_FILE"
  : > "$RESP_FILE"
  mkdir -p "$RUNTIME_DIR"
  export CREWLY_API_URL="http://127.0.0.1:${PORT}"
  export CREWLY_RUNTIME_DIR="$RUNTIME_DIR"
}

# Push a canned response onto the stub queue.
queue_response() {
  printf '%s\n' "$1" >> "$RESP_FILE"
}

start_stub() {
  STUB_PID=$(start_stub_server "$PORT" "$LOG_FILE" "$RESP_FILE")
  # Wait for the server to be ready (poll the port).
  local tries=0
  until python3 -c "import socket; s=socket.socket(); s.settimeout(0.2); s.connect(('127.0.0.1', $PORT))" 2>/dev/null; do
    tries=$((tries + 1))
    if [ $tries -gt 50 ]; then
      fail "stub server failed to start within 5s"
      return 1
    fi
    sleep 0.1
  done
}

scenario_teardown() {
  if [ -n "${STUB_PID:-}" ]; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  unset CREWLY_API_URL CREWLY_RUNTIME_DIR CREWLY_SESSION_NAME STUB_PID WORK_DIR PORT
  unset LOG_FILE RESP_FILE RUNTIME_DIR
}

# Read a logged request — `nth` is 0-indexed.
request_field() {
  local nth="$1" field="$2"
  python3 -c "
import json, sys
with open('${LOG_FILE}') as f:
    lines = [json.loads(l) for l in f if l.strip()]
idx = int('${nth}')
if idx >= len(lines):
    sys.exit(0)
entry = lines[idx]
keys = '${field}'.split('.')
v = entry
for k in keys:
    if isinstance(v, dict):
        v = v.get(k)
    else:
        v = None
        break
if v is None:
    print('', end='')
else:
    print(v if isinstance(v, str) else json.dumps(v), end='')
"
}

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

# Scenario 1: bind-tab caches tabId locally
scenario_init "scenario 1: bind-tab caches tabId"
queue_response '{"success":true,"data":{"tabId":42,"windowId":9}}'
start_stub
export CREWLY_SESSION_NAME="agent-1"
out=$("$SKILL" --action bind-tab 2>&1) || true
assert_contains "bind-tab response carries tabId" "$out" '"tabId":42'
assert_eq "stub got POST /api/browser/bind" "POST /api/browser/bind" "$(request_field 0 method) $(request_field 0 path)"
assert_eq "X-Agent-Session forwarded" "agent-1" "$(request_field 0 headers.X-Agent-Session)"
[ -f "${RUNTIME_DIR}/agent-1/browser-tab-id" ] \
  && pass "cache file written" \
  || fail "cache file written" "missing ${RUNTIME_DIR}/agent-1/browser-tab-id"
assert_eq "cache content = tabId" "42" "$(cat ${RUNTIME_DIR}/agent-1/browser-tab-id 2>/dev/null)"
scenario_teardown

# Scenario 2: subsequent action injects cached tabId into body
scenario_init "scenario 2: cached tabId injected into body"
mkdir -p "${RUNTIME_DIR}/agent-2"
echo "77" > "${RUNTIME_DIR}/agent-2/browser-tab-id"
queue_response '{"success":true,"data":{"text":"hello"}}'
start_stub
export CREWLY_SESSION_NAME="agent-2"
"$SKILL" --action read-text > /dev/null 2>&1 || true
body=$(request_field 0 body)
assert_contains "read-text body contains tabId:77" "$body" '"tabId":77'
scenario_teardown

# Scenario 3: --tab-id flag overrides cache
scenario_init "scenario 3: --tab-id flag overrides cache"
mkdir -p "${RUNTIME_DIR}/agent-3"
echo "55" > "${RUNTIME_DIR}/agent-3/browser-tab-id"
queue_response '{"success":true,"data":{}}'
start_stub
export CREWLY_SESSION_NAME="agent-3"
"$SKILL" --action read-text --tab-id 999 > /dev/null 2>&1 || true
body=$(request_field 0 body)
assert_contains "body uses --tab-id override" "$body" '"tabId":999'
scenario_teardown

# Scenario 4: --no-bind drops X-Agent-Session header
scenario_init "scenario 4: --no-bind drops session header"
queue_response '{"success":true,"data":{}}'
start_stub
export CREWLY_SESSION_NAME="agent-4"
"$SKILL" --action read-text --no-bind > /dev/null 2>&1 || true
hdr=$(request_field 0 headers.X-Agent-Session)
assert_eq "no X-Agent-Session header on --no-bind" "" "$hdr"
scenario_teardown

# Scenario 5: unbind-tab purges cache
scenario_init "scenario 5: unbind-tab purges cache"
mkdir -p "${RUNTIME_DIR}/agent-5"
echo "33" > "${RUNTIME_DIR}/agent-5/browser-tab-id"
queue_response '{"success":true,"data":{"released":true,"tabClosed":true}}'
start_stub
export CREWLY_SESSION_NAME="agent-5"
"$SKILL" --action unbind-tab > /dev/null 2>&1 || true
[ -f "${RUNTIME_DIR}/agent-5/browser-tab-id" ] \
  && fail "cache should be purged" "still present at ${RUNTIME_DIR}/agent-5/browser-tab-id" \
  || pass "cache file purged"
scenario_teardown

# Scenario 6: 404 tab_not_found triggers cache purge + auto-retry
scenario_init "scenario 6: 404 tab_not_found triggers retry"
mkdir -p "${RUNTIME_DIR}/agent-6"
echo "100" > "${RUNTIME_DIR}/agent-6/browser-tab-id"
# First call: 404 with tab_not_found body
queue_response '404|{"success":false,"error":"tab_not_found","details":"Tab 100 closed"}'
# Second call (retry without tabId): success
queue_response '{"success":true,"data":{"text":"recovered"}}'
start_stub
export CREWLY_SESSION_NAME="agent-6"
out=$("$SKILL" --action read-text 2>&1) || true
# Two requests should have been made.
total_reqs=$(wc -l < "$LOG_FILE")
assert_eq "stub received 2 requests" "2" "$(printf '%s' "$total_reqs" | tr -d ' ')"
# First request had tabId:100, second omits tabId (auto-bind path)
first_body=$(request_field 0 body)
second_body=$(request_field 1 body)
assert_contains "first request had stale tabId:100" "$first_body" '"tabId":100'
[ -z "$(printf '%s' "$second_body" | grep -o '"tabId"' || true)" ] \
  && pass "retry request omitted tabId (auto-bind path)" \
  || fail "retry request omitted tabId" "second_body=$second_body"
[ -f "${RUNTIME_DIR}/agent-6/browser-tab-id" ] \
  && fail "cache purged on 404" "still present" \
  || pass "cache purged on 404"
scenario_teardown

# Scenario 7: bind-tab with --active sends active:true
scenario_init "scenario 7: bind-tab --active forwards foreground flag"
queue_response '{"success":true,"data":{"tabId":7}}'
start_stub
export CREWLY_SESSION_NAME="agent-7"
"$SKILL" --action bind-tab --active > /dev/null 2>&1 || true
body=$(request_field 0 body)
assert_contains "body contains active:true" "$body" '"active":true'
scenario_teardown

# Scenario 8: no CREWLY_SESSION_NAME — no cache, no tabId, legacy fallback
scenario_init "scenario 8: missing CREWLY_SESSION_NAME → legacy active-tab path"
queue_response '{"success":true,"data":{}}'
start_stub
unset CREWLY_SESSION_NAME
"$SKILL" --action read-text > /dev/null 2>&1 || true
hdr=$(request_field 0 headers.X-Agent-Session)
body=$(request_field 0 body)
assert_eq "no X-Agent-Session header" "" "$hdr"
[ -z "$(printf '%s' "$body" | grep -o '"tabId"' || true)" ] \
  && pass "body has no tabId field" \
  || fail "body has no tabId field" "body=$body"
scenario_teardown

# Scenario 9: scroll with passthrough params produces valid JSON body
# Regression guard for the `${EXTRA_PARAMS:-{}}` bash bug — when EXTRA_PARAMS
# was non-empty, the literal trailing `}` from the default leaked through and
# produced `{"direction":"down"}}` (invalid JSON), causing express.json() to
# reject the request with HTTP 400. The fix routes through emit_body().
scenario_init "scenario 9: scroll with extra params emits valid JSON"
queue_response '{"success":true,"data":{"scrolled":true}}'
start_stub
unset CREWLY_SESSION_NAME
"$SKILL" '{"action":"scroll","direction":"down","amount":500}' > /dev/null 2>&1 || true
body=$(request_field 0 body)
# Body must be parseable JSON — the old buggy path would emit a stray `}`.
if printf '%s' "$body" | python3 -c 'import sys, json; json.loads(sys.stdin.read())' 2>/dev/null; then
  pass "scroll body parses as JSON"
else
  fail "scroll body parses as JSON" "body=$body"
fi
assert_contains "scroll body has direction:down" "$body" '"direction":"down"'
assert_contains "scroll body has amount:500" "$body" '"amount":500'
# Negative assertion: no double-closing brace
case "$body" in
  *'}}'*) fail "scroll body must not have trailing }}" "body=$body" ;;
  *) pass "scroll body has no trailing }}" ;;
esac
scenario_teardown

# Scenario 10: scroll with NO extra params emits valid `{}`
scenario_init "scenario 10: scroll without params emits {}"
queue_response '{"success":true,"data":{"scrolled":false}}'
start_stub
unset CREWLY_SESSION_NAME
"$SKILL" --action scroll > /dev/null 2>&1 || true
body=$(request_field 0 body)
assert_eq "empty-params scroll body == {}" '{}' "$body"
scenario_teardown

# Scenario 11: select-option with explicit value
# Native <select> dropdowns can't be operated by CDP click — verify the new
# select-option action routes to /browser/select-option with selector+value.
scenario_init "scenario 11: select-option with --selector + --value"
queue_response '{"success":true,"data":{"selected":true,"matchedBy":"value"}}'
start_stub
unset CREWLY_SESSION_NAME
"$SKILL" --action select-option --selector "#status" --value "active" > /dev/null 2>&1 || true
assert_eq "POST /api/browser/select-option" "POST /api/browser/select-option" "$(request_field 0 method) $(request_field 0 path)"
body=$(request_field 0 body)
assert_contains "body has selector" "$body" '"selector":"#status"'
assert_contains "body has value" "$body" '"value":"active"'
scenario_teardown

# Scenario 12: select-option via JSON input — label + index pass through
scenario_init "scenario 12: select-option JSON with label + index"
queue_response '{"success":true,"data":{"selected":true,"matchedBy":"index"}}'
start_stub
unset CREWLY_SESSION_NAME
"$SKILL" '{"action":"select-option","selector":".course-filter","label":"Active","index":2}' > /dev/null 2>&1 || true
body=$(request_field 0 body)
# Body must be valid JSON (regression on the same bash gotcha from scenario 9).
if printf '%s' "$body" | python3 -c 'import sys, json; json.loads(sys.stdin.read())' 2>/dev/null; then
  pass "select-option body parses as JSON"
else
  fail "select-option body parses as JSON" "body=$body"
fi
assert_contains "body has selector" "$body" '"selector":".course-filter"'
assert_contains "body has label" "$body" '"label":"Active"'
assert_contains "body has index" "$body" '"index":2'
scenario_teardown

# Scenario 13: select-option with strategy="aria" passes through verbatim
# Used for custom React comboboxes (Radix/HeadlessUI/MUI/Mantine/Ant Design).
scenario_init "scenario 13: select-option strategy=aria passthrough"
queue_response '{"success":true,"data":{"selected":true,"strategy":"aria","matchedBy":"label"}}'
start_stub
unset CREWLY_SESSION_NAME
"$SKILL" '{"action":"select-option","selector":"[role=combobox]","label":"Math 101","strategy":"aria"}' > /dev/null 2>&1 || true
body=$(request_field 0 body)
assert_contains "body has strategy:aria" "$body" '"strategy":"aria"'
assert_contains "body has selector" "$body" '"selector":"[role=combobox]"'
assert_contains "body has label" "$body" '"label":"Math 101"'
scenario_teardown

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
TOTAL=$((PASS_COUNT + FAIL_COUNT))
if [ "$FAIL_COUNT" -gt 0 ]; then
  printf '\033[31mFAIL\033[0m  %d/%d passed (%d failed)\n' "$PASS_COUNT" "$TOTAL" "$FAIL_COUNT"
  exit 1
else
  printf '\033[32mOK\033[0m    %d/%d passed\n' "$PASS_COUNT" "$TOTAL"
  exit 0
fi
