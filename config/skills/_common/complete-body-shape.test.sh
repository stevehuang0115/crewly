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

# The exact key set `completeItem` destructures from req.body:
#   const { agentId, tokenUsage, result } = req.body
# (`workItemId` arrives as a PATH param, not in the body.)
#
# Added 2026-08-21 after `skipGates` shipped as a dead field: the skill parsed
# it, put it on the wire, and nothing read it — POST /task-pool/complete runs no
# quality gates at all. The per-field assertions below could not catch that,
# because you cannot write an assertion for a field you do not know exists.
# A key-SUBSET assertion catches the whole class instead of one field at a time.
# Ported from the sibling task-pool-body-shape.test.sh, where the same shape
# found three unknown instances on its first run.
COMPLETE_ALLOWED_KEYS='["agentId","tokenUsage","result"]'

# Assert a captured /task-pool/complete body carries only keys the endpoint reads.
assert_complete_contract() {
  local label="$1" body="$2"
  local extra
  extra=$(printf '%s' "$body" | jq -c --argjson allowed "$COMPLETE_ALLOWED_KEYS" '[keys[] | select(. as $k | $allowed | index($k) == null)]')
  if [ "$extra" = "[]" ]; then
    PASS=$((PASS + 1)); echo "  ✓ ${label}: every top-level key is read by completeItem"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${label}: keys silently discarded by completeItem: ${extra}"
    echo "    completeItem destructures only {agentId, tokenUsage, result}."
    echo "    A key outside that set is accepted, dropped, and believed to have worked."
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
            # MULTI_RUNNING makes the pool report TWO running WorkItems, so the
            # resolution in report-status becomes ambiguous and must refuse.
            if os.path.exists(LOG + ".multi"):
                self.wfile.write(b"{\"workItems\":[{\"id\":\"wi-stub-1\"},{\"id\":\"wi-stub-2\"}]}")
                return
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
  assert_complete_contract "report-status" "$COMPLETE_BODY"
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
  assert_complete_contract "complete-task" "$COMPLETE_BODY"
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
  assert_complete_contract "orc-complete-task" "$COMPLETE_BODY"
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
  assert_complete_contract "scenario-4" "$COMPLETE_BODY"
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

# ---------------------------------------------------------------------------
# Scenario 5 — complete-task REJECTS skipGates loudly
#
# skipGates was accepted and silently discarded: the skill put it on the wire
# and completeItem never read it, so a caller believed gates were skipped when
# POST /task-pool/complete runs no gates at all. The disposition chosen was
# reject-loudly rather than honour (incoherent — nothing to skip) or drop
# silently (leaves the false belief intact). This locks that in.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 5: complete-task rejects skipGates ---"
: > "$LOG"
SKIPGATES_OUT=$(bash "${REPO_ROOT}/config/skills/agent/core/complete-task/execute.sh" \
  '{"workItemId":"wi-stub-1","sessionName":"quinn-sg","summary":"s","skipGates":true}' 2>&1 || true)
SKIPGATES_RC=$?

if printf '%s' "$SKIPGATES_OUT" | grep -q "skipGates is not supported"; then
  PASS=$((PASS + 1)); echo "  ✓ errors with an explanation naming the field"
else
  FAIL=$((FAIL + 1)); echo "  ✗ expected a skipGates rejection, got: ${SKIPGATES_OUT}"
fi

if printf '%s' "$SKIPGATES_OUT" | grep -q "check-quality-gates"; then
  PASS=$((PASS + 1)); echo "  ✓ points the caller at where gates actually live"
else
  FAIL=$((FAIL + 1)); echo "  ✗ rejection does not say where to run gates instead"
fi

if grep -qF '"path": "/api/task-pool/complete/' "$LOG"; then
  FAIL=$((FAIL + 1)); echo "  ✗ completed the WorkItem anyway — rejection must happen BEFORE the POST"
else
  PASS=$((PASS + 1)); echo "  ✓ no complete POST emitted — fails before mutating state"
fi

# ---------------------------------------------------------------------------
# Scenario 6 — report-status WorkItem resolution (instance 11)
#
# report-status completed `.data[0].id` — an arbitrary first running WI. On
# 2026-08-21 that silently closed WorkItem 7db3b00c, work nobody had started,
# while the agent was reporting a DIFFERENT item done. Nothing failed, and the
# false completion spawned a verify WI for a delivery that never happened.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 6: report-status resolution ---"

# 6a — an explicit workItemId must win over anything the pool reports.
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/report-status/execute.sh" \
  --session quinn-res --status done --summary "Explicit workItemId resolution scenario" \
  --project /tmp/proj-foo --work-item-id wi-explicit-9 >/dev/null 2>&1 || true
if grep -qF '"path": "/api/task-pool/complete/wi-explicit-9"' "$LOG"; then
  PASS=$((PASS + 1)); echo "  ✓ explicit workItemId is the one completed"
else
  ACTUAL=$(grep -oE '/api/task-pool/complete/[^"]*' "$LOG" | head -1)
  FAIL=$((FAIL + 1)); echo "  ✗ expected wi-explicit-9 to be completed, got: ${ACTUAL:-none}"
fi

# 6b — the stub returns TWO running WIs, so inference is ambiguous. It must
# REFUSE and complete nothing, naming the candidates.
: > "$LOG"
touch "${LOG}.multi"
MULTI_OUT=$(bash "${REPO_ROOT}/config/skills/agent/core/report-status/execute.sh" \
  --session quinn-res --status done --summary "Ambiguous resolution refusal scenario" \
  --project /tmp/proj-foo 2>&1 || true)
rm -f "${LOG}.multi"
if grep -qF '"path": "/api/task-pool/complete/' "$LOG"; then
  FAIL=$((FAIL + 1)); echo "  ✗ completed a WorkItem despite ambiguous resolution — this is the 7db3b00c bug"
else
  PASS=$((PASS + 1)); echo "  ✓ completes nothing when more than one WI is running"
fi
if printf '%s' "$MULTI_OUT" | grep -q "refuses to guess"; then
  PASS=$((PASS + 1)); echo "  ✓ refusal explains why and tells the caller to pass workItemId"
else
  FAIL=$((FAIL + 1)); echo "  ✗ expected a refusal naming the ambiguity, got: ${MULTI_OUT}"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
