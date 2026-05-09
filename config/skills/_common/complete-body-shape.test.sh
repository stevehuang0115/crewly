#!/bin/bash
# =============================================================================
# Hygiene #4 (2026-05-09) — wire-shape smoke test for /api/task-pool/complete
#
# Brief allows: "a smoke test that verifies the JSON body shape against the
# controller's accepted schema" (.crewly/specs equivalent). This is that test.
#
# Covers the 3 skill callsites that emit POSTs to /task-pool/complete:
#   1. config/skills/agent/core/report-status/execute.sh        (status=done branch)
#   2. config/skills/agent/core/complete-task/execute.sh        (always)
#   3. config/skills/orchestrator/complete-task/execute.sh      (always)
#
# Strategy: spin up a Python HTTP stub that records every POST body; point
# each skill at it via CREWLY_API_URL; assert the captured body matches the
# canonical `{agentId, result:{summary}, ...}` shape required by
# task-pool.controller.ts `completeItem`.
#
# Pattern mirrors the existing `config/skills/agent/remote-browser/
# execute.test.sh` Python-stub harness — same JSONL request log, same
# subshell-pid trick.
#
# Test runner:
#   bash config/skills/_common/complete-body-shape.test.sh
#   echo $?    # 0 on pass, 1 on fail
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
PASS=0
FAIL=0

assert_eq_json() {
  local test_name="$1" expected="$2" actual="$3"
  # Normalize both via jq -S so key order does not matter.
  local norm_expected norm_actual
  norm_expected=$(printf '%s' "$expected" | jq -S '.' 2>/dev/null || echo "INVALID_JSON_EXPECTED")
  norm_actual=$(printf '%s' "$actual" | jq -S '.' 2>/dev/null || echo "INVALID_JSON_ACTUAL")
  if [ "$norm_expected" = "$norm_actual" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${test_name}"
    echo "    expected: ${norm_expected}"
    echo "    actual:   ${norm_actual}"
  fi
}

assert_jq() {
  local test_name="$1" jq_filter="$2" body="$3"
  local result
  result=$(printf '%s' "$body" | jq -er "$jq_filter" 2>/dev/null || true)
  if [ -n "$result" ] && [ "$result" != "null" ] && [ "$result" != "false" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${test_name}"
    echo "    filter: ${jq_filter}"
    echo "    body:   ${body}"
  fi
}

start_stub() {
  local port="$1" log_file="$2"
  PORT=$port LOG_FILE=$log_file \
    python3 -c '
import http.server, json, os, sys
LOG = os.environ["LOG_FILE"]
PORT = int(os.environ["PORT"])

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a, **kw): pass  # quiet
    def _record(self, body_bytes):
        with open(LOG, "a") as f:
            f.write(json.dumps({
                "method": self.command,
                "path": self.path,
                "body": body_bytes.decode("utf-8") if body_bytes else "",
            }) + "\n")
    def _ok(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{\"success\":true}")
    def do_POST(self):
        ln = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(ln) if ln else b""
        self._record(body)
        # Specific handling for the resolve-running-WI fallback
        if self.path.startswith("/api/task-pool/items"):
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.end_headers()
            # Top-level workItems shape — matches the jq fallback chain
            # in the skills (`.workItems[0].id // .data[0].id // empty`).
            self.wfile.write(b"{\"workItems\":[{\"id\":\"wi-stub-1\"}]}")
            return
        self._ok()
    def do_GET(self):
        self._record(b"")
        if self.path.startswith("/api/task-pool/items"):
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.end_headers()
            # Top-level workItems shape — matches the jq fallback chain
            # in the skills (`.workItems[0].id // .data[0].id // empty`).
            self.wfile.write(b"{\"workItems\":[{\"id\":\"wi-stub-1\"}]}")
            return
        self._ok()

httpd = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
httpd.serve_forever()
' >/dev/null 2>&1 &
  echo $!
}

# ---------------------------------------------------------------------------
# Per-skill scenario harness
# ---------------------------------------------------------------------------
PORT=39184
TMPROOT=$(mktemp -d -t crewly-hygiene4-XXXXXX)
LOG="${TMPROOT}/requests.jsonl"
: > "$LOG"

STUB_PID=$(start_stub "$PORT" "$LOG")
trap "kill $STUB_PID 2>/dev/null || true; rm -rf $TMPROOT" EXIT

# Wait briefly for the HTTP server to bind.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

export CREWLY_API_URL="http://127.0.0.1:${PORT}"

echo "=== Hygiene #4 — /task-pool/complete body-shape smoke ==="

# ---------------------------------------------------------------------------
# Scenario 1 — agent/core/report-status (status=done branch)
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 1: agent/core/report-status status=done ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/report-status/execute.sh" \
  --session quinn-test --status done \
  --summary "Report-status smoke summary" \
  --project /tmp/proj-foo >/dev/null 2>&1 || true

# Expect at least one POST to /api/task-pool/complete/ — find it.
COMPLETE_LINE=$(grep -F '"path": "/api/task-pool/complete/' "$LOG" | head -1 || true)
if [ -z "$COMPLETE_LINE" ]; then
  FAIL=$((FAIL + 1))
  echo "  ✗ no /task-pool/complete POST captured"
else
  COMPLETE_BODY=$(printf '%s' "$COMPLETE_LINE" | jq -r '.body')
  assert_jq "agentId is the session name" '.agentId == "quinn-test"' "$COMPLETE_BODY"
  assert_jq "result.summary is non-empty" '.result.summary | length > 0' "$COMPLETE_BODY"
  assert_jq "result.summary matches input" '.result.summary == "Report-status smoke summary"' "$COMPLETE_BODY"
  assert_jq "no top-level summary leak (strict shape)" '.summary == null' "$COMPLETE_BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 2 — agent/core/complete-task
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 2: agent/core/complete-task ---"
: > "$LOG"
TASK_DIR=$(mktemp -d -t crewly-hygiene4-task-XXXXXX)
TASK_PATH="${TASK_DIR}/task.md"
echo "# task" > "$TASK_PATH"

bash "${REPO_ROOT}/config/skills/agent/core/complete-task/execute.sh" \
  '{"absoluteTaskPath":"'"$TASK_PATH"'","sessionName":"quinn-ct","summary":"Complete-task smoke summary","workItemId":"wi-stub-1","output":{"prNumber":42,"callsites":5}}' \
  >/dev/null 2>&1 || true

COMPLETE_LINE=$(grep -F '"path": "/api/task-pool/complete/' "$LOG" | head -1 || true)
if [ -z "$COMPLETE_LINE" ]; then
  FAIL=$((FAIL + 1))
  echo "  ✗ no /task-pool/complete POST captured"
else
  COMPLETE_BODY=$(printf '%s' "$COMPLETE_LINE" | jq -r '.body')
  assert_jq "agentId is the session name" '.agentId == "quinn-ct"' "$COMPLETE_BODY"
  assert_jq "result.summary matches" '.result.summary == "Complete-task smoke summary"' "$COMPLETE_BODY"
  assert_jq "result.prNumber merged into result (was top-level result before)" '.result.prNumber == 42' "$COMPLETE_BODY"
  assert_jq "result.callsites merged into result" '.result.callsites == 5' "$COMPLETE_BODY"
  assert_jq "no top-level summary leak" '.summary == null' "$COMPLETE_BODY"
fi
rm -rf "$TASK_DIR"

# ---------------------------------------------------------------------------
# Scenario 3 — orchestrator/complete-task
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 3: orchestrator/complete-task ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/orchestrator/complete-task/execute.sh" \
  '{"workItemId":"wi-stub-1","summary":"Orc complete-task smoke summary"}' \
  >/dev/null 2>&1 || true

COMPLETE_LINE=$(grep -F '"path": "/api/task-pool/complete/' "$LOG" | head -1 || true)
if [ -z "$COMPLETE_LINE" ]; then
  FAIL=$((FAIL + 1))
  echo "  ✗ no /task-pool/complete POST captured"
else
  COMPLETE_BODY=$(printf '%s' "$COMPLETE_LINE" | jq -r '.body')
  assert_jq "agentId defaults to crewly-orc" '.agentId == "crewly-orc"' "$COMPLETE_BODY"
  assert_jq "result.summary matches" '.result.summary == "Orc complete-task smoke summary"' "$COMPLETE_BODY"
  assert_jq "no top-level summary leak" '.summary == null' "$COMPLETE_BODY"
fi

echo ""
echo "--- Scenario 3b: orchestrator/complete-task with explicit agentId override ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/orchestrator/complete-task/execute.sh" \
  '{"workItemId":"wi-stub-1","summary":"Orc on-behalf-of summary","agentId":"crewly-product-leo-21a5477e"}' \
  >/dev/null 2>&1 || true

COMPLETE_LINE=$(grep -F '"path": "/api/task-pool/complete/' "$LOG" | head -1 || true)
if [ -z "$COMPLETE_LINE" ]; then
  FAIL=$((FAIL + 1))
  echo "  ✗ no /task-pool/complete POST captured"
else
  COMPLETE_BODY=$(printf '%s' "$COMPLETE_LINE" | jq -r '.body')
  assert_jq "agentId overridden to caller value" '.agentId == "crewly-product-leo-21a5477e"' "$COMPLETE_BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 4 — orchestrator/complete-task rejects empty summary
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 4: orchestrator/complete-task rejects empty summary ---"
: > "$LOG"
EXIT=0
OUTPUT=$(bash "${REPO_ROOT}/config/skills/orchestrator/complete-task/execute.sh" \
  '{"workItemId":"wi-stub-1","summary":""}' 2>&1) || EXIT=$?

if [ "$EXIT" -ne 0 ] && printf '%s' "$OUTPUT" | grep -q "summary is required"; then
  PASS=$((PASS + 1))
  echo "  ✓ exits non-zero with helpful 'summary is required' error"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ should reject empty summary; exit=$EXIT, output=$OUTPUT"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
