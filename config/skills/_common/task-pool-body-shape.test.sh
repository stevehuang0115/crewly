#!/bin/bash
# =============================================================================
# Wire-shape contract test for /api/task-pool/add and /api/task-pool/claim
#
# Sibling of `complete-body-shape.test.sh`, which covers /task-pool/complete.
# Same harness: a Python HTTP stub records every POST body, each skill is
# pointed at it via CREWLY_API_URL, and the CAPTURED body is asserted against
# the shape the controller actually destructures.
#
# WHY THIS EXISTS
# ---------------
# Five separate skills have now shipped a POST body the controller never
# reads. Nothing binds a skill's request body to the shape its controller
# destructures, so they drift silently and independently:
#   #734  complete-task + both delegate-task skills  (/task-pool/complete)
#   #735-family  agent/core/accept-task              (/task-pool/claim)
#   #735-family  agent/core/create-task              (/task-pool/add)
# Five instances is not five bugs — it is one missing contract. This test is
# that contract for the two endpoints in the create/claim family.
#
# The failures are invisible without an executing test: a skill that posts an
# unread field gets a 200 and reports success, while the field is dropped. A
# static grep of the jq literal would pass for the wrong reason. So this test
# EXECUTES each skill and inspects the bytes that actually went on the wire.
#
# Test runner:
#   bash config/skills/_common/task-pool-body-shape.test.sh
#   echo $?    # 0 on pass, 1 on fail
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
PASS=0
FAIL=0

# The exact key set `blockItem` destructures from req.body:
#   const { agentId, reason } = req.body   — and agentId is HARD-REQUIRED (400)
BLOCK_ALLOWED_KEYS='["agentId","reason"]'

# The exact key set `claimItem` destructures from req.body:
#   const { agentId, workItemId, filters } = req.body
CLAIM_ALLOWED_KEYS='["agentId","filters","workItemId"]'

# The WorkItemOwner enum accepted by validateCreateWorkItemInput.
OWNER_ENUM='["orchestrator","team_lead","agent","system"]'

# Every field of `CreateWorkItemInput` (backend/src/types/v2/work-item.types.ts),
# plus the three legacy-full-shape fields addItem inspects to decide which path
# to take. Anything OUTSIDE this set is silently discarded by the endpoint:
# `createWorkItem(input)` copies named fields only, so an unknown key produces
# a 200 and vanishes. That is the whole bug family in one assertion.
ADD_ALLOWED_KEYS='["id","requestId","parentWorkItemId","type","owner","target","title","description","briefMarkdown","scheduledAt","maxRetries","triggerId","projectTaskId","missionId","metadata","dependsOn","status","createdAt","retryCount","inputTokens","outputTokens","cost"]'

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

# Assert a captured /task-pool/add body is a shape `addItem` actually reads.
# Applied uniformly to every /add callsite — this is the contract itself.
assert_add_contract() {
  local label="$1" body="$2"
  # 1. No envelope. addItem reads `req.body` directly; `{workItem: {...}}`
  #    makes every real field invisible and 400s on `type`/`owner`/`title`.
  assert_jq "${label}: no {workItem:...} envelope" '.workItem == null' "$body"
  # 2. Minimal CreateWorkItemInput required fields, at top level.
  assert_jq "${label}: type is a string" '.type | type == "string"' "$body"
  assert_jq "${label}: title is a non-empty string" '.title | type == "string" and length > 0' "$body"
  # 3. owner is the WorkItemOwner ROLE enum, not a session name.
  local owner
  owner=$(printf '%s' "$body" | jq -r '.owner // ""')
  if printf '%s' "$OWNER_ENUM" | jq -e --arg o "$owner" 'index($o) != null' >/dev/null 2>&1; then
    PASS=$((PASS + 1)); echo "  ✓ ${label}: owner '${owner}' is a valid WorkItemOwner"
  else
    FAIL=$((FAIL + 1)); echo "  ✗ ${label}: owner '${owner}' is NOT a WorkItemOwner (expected one of ${OWNER_ENUM})"
  fi
  # 4. No key outside CreateWorkItemInput. This is the general form of the
  #    bug: `priority` and `projectPath` are NOT WorkItem fields, so a caller
  #    passing --priority critical believes it took effect while the endpoint
  #    drops it. Such values belong in `metadata`.
  local extra_add
  extra_add=$(printf '%s' "$body" | jq -c --argjson allowed "$ADD_ALLOWED_KEYS" '[keys[] | select(. as $k | $allowed | index($k) == null)]')
  if [ "$extra_add" = "[]" ]; then
    PASS=$((PASS + 1)); echo "  ✓ ${label}: every top-level key is read by the endpoint"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${label}: keys silently discarded by addItem: ${extra_add}"
    echo "    These are not CreateWorkItemInput fields — move them into metadata."
  fi
  # 5. If an id is sent it must be accompanied by status AND createdAt,
  #    otherwise isLegacyFullShape is false and the caller's intent is
  #    ambiguous. Either commit to the legacy full shape or send neither.
  local has_id has_status has_created
  has_id=$(printf '%s' "$body" | jq -r 'has("id")')
  has_status=$(printf '%s' "$body" | jq -r 'has("status")')
  has_created=$(printf '%s' "$body" | jq -r 'has("createdAt")')
  if [ "$has_id" = "false" ] || { [ "$has_status" = "true" ] && [ "$has_created" = "true" ]; }; then
    PASS=$((PASS + 1)); echo "  ✓ ${label}: id/status/createdAt are consistent (minimal or full, not half)"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${label}: half-legacy shape — id=${has_id} status=${has_status} createdAt=${has_created}"
    echo "    A body with id but no createdAt takes the MINIMAL path; send all three or none."
  fi
}

# Assert a captured /task-pool/claim body only carries keys claimItem reads.
assert_claim_contract() {
  local label="$1" body="$2"
  assert_jq "${label}: agentId is a non-empty string" '.agentId | type == "string" and length > 0' "$body"
  local extra
  extra=$(printf '%s' "$body" | jq -c --argjson allowed "$CLAIM_ALLOWED_KEYS" '[keys[] | select(. as $k | $allowed | index($k) == null)]')
  if [ "$extra" = "[]" ]; then
    PASS=$((PASS + 1)); echo "  ✓ ${label}: no keys outside {agentId, workItemId, filters}"
  else
    FAIL=$((FAIL + 1)); echo "  ✗ ${label}: body carries keys the controller never reads: ${extra}"
  fi
}

# Assert a captured /task-pool/block body matches what blockItem reads.
assert_block_contract() {
  local label="$1" body="$2"
  assert_jq "${label}: agentId present (endpoint 400s without it)" '.agentId | type == "string" and length > 0' "$body"
  assert_jq "${label}: reason is a non-empty string" '.reason | type == "string" and length > 0' "$body"
  local extra
  extra=$(printf '%s' "$body" | jq -c --argjson allowed "$BLOCK_ALLOWED_KEYS" '[keys[] | select(. as $k | $allowed | index($k) == null)]')
  if [ "$extra" = "[]" ]; then
    PASS=$((PASS + 1)); echo "  ✓ ${label}: no keys outside {agentId, reason}"
  else
    FAIL=$((FAIL + 1)); echo "  ✗ ${label}: keys silently discarded by blockItem: ${extra}"
  fi
}

start_stub() {
  local port="$1" log_file="$2"
  PORT=$port LOG_FILE=$log_file \
    python3 -c '
import http.server, json, os
LOG = os.environ["LOG_FILE"]
PORT = int(os.environ["PORT"])

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a, **kw): pass
    def _record(self, body_bytes):
        with open(LOG, "a") as f:
            f.write(json.dumps({
                "method": self.command,
                "path": self.path,
                "body": body_bytes.decode("utf-8") if body_bytes else "",
            }) + "\n")
    def _json(self, payload):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)
    def do_POST(self):
        ln = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(ln) if ln else b""
        self._record(body)
        if self.path.startswith("/api/task-pool/claim"):
            self._json(b"{\"success\":true,\"data\":{\"workItem\":{\"id\":\"wi-stub-1\",\"title\":\"stub\"},\"claim\":{\"id\":\"claim-1\"}}}")
            return
        if self.path.startswith("/api/task-pool/add"):
            self._json(b"{\"success\":true,\"data\":{\"id\":\"wi-stub-1\",\"workItemId\":\"wi-stub-1\",\"status\":\"queued\"}}")
            return
        self._json(b"{\"success\":true}")
    def do_GET(self):
        self._record(b"")
        # block-task pre-checks item status before calling /block.
        # NOTE: this block lives inside a bash single-quoted python3 -c
        # argument, so it must contain NO apostrophe characters at all —
        # a stray one silently terminates the bash string and the file
        # then fails to parse many lines later.
        # A marker file lets a scenario choose what status is reported; with
        # no marker the status is absent and the pre-check is skipped, which
        # keeps every pre-existing scenario behaving as before.
        marker = LOG + ".status"
        if self.path.startswith("/api/task-pool/items/") and os.path.exists(marker):
            with open(marker) as f:
                st = f.read().strip()
            self._json(json.dumps({"success": True, "data": {"id": "wi-stub-1", "status": st}}).encode())
            return
        self._json(b"{\"success\":true,\"data\":[],\"workItems\":[]}")

httpd = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
httpd.serve_forever()
' >/dev/null 2>&1 &
  echo $!
}

PORT=39185
TMPROOT=$(mktemp -d -t crewly-taskpool-shape-XXXXXX)
LOG="${TMPROOT}/requests.jsonl"
: > "$LOG"

STUB_PID=$(start_stub "$PORT" "$LOG")
trap "kill $STUB_PID 2>/dev/null || true; rm -rf $TMPROOT" EXIT

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

export CREWLY_API_URL="http://127.0.0.1:${PORT}"

capture() { grep -F "\"path\": \"$1\"" "$LOG" | head -1 | jq -r '.body' 2>/dev/null || true; }

echo "=== /task-pool/add + /task-pool/claim body-shape contract ==="

# ---------------------------------------------------------------------------
# Scenario 1 — agent/core/create-task -> /task-pool/add
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 1: agent/core/create-task -> /add ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/create-task/execute.sh" \
  --project-path /tmp/proj-foo --task "Contract test task" \
  --priority high --session quinn-target >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/add")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/add POST captured"
else
  assert_add_contract "create-task" "$BODY"
  assert_jq "create-task: target is the session name" '.target == "quinn-target"' "$BODY"
  assert_jq "create-task: priority preserved in metadata.priority" '.metadata.priority == "high"' "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 2 — agent/core/accept-task -> /task-pool/claim (targeted)
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 2: agent/core/accept-task targeted -> /claim ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/accept-task/execute.sh" \
  '{"sessionName":"quinn-claimer","workItemId":"wi-requested-42"}' >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/claim")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/claim POST captured"
else
  assert_claim_contract "accept-task(targeted)" "$BODY"
  assert_jq "accept-task(targeted): requested workItemId IS forwarded" '.workItemId == "wi-requested-42"' "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 3 — accept-task taskId alias -> /claim
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 3: agent/core/accept-task taskId alias -> /claim ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/accept-task/execute.sh" \
  '{"sessionName":"quinn-claimer","taskId":"wi-alias-7"}' >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/claim")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/claim POST captured"
else
  assert_claim_contract "accept-task(alias)" "$BODY"
  assert_jq "accept-task(alias): taskId is forwarded as workItemId" '.workItemId == "wi-alias-7"' "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 4 — accept-task next-available -> /claim (no workItemId)
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 4: agent/core/accept-task FIFO -> /claim ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/accept-task/execute.sh" \
  '{"sessionName":"quinn-claimer"}' >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/claim")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/claim POST captured"
else
  assert_claim_contract "accept-task(fifo)" "$BODY"
  assert_jq "accept-task(fifo): omits workItemId entirely" 'has("workItemId") == false' "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 5 — team-leader/delegate-task -> /task-pool/add
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 5: team-leader/delegate-task -> /add ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/team-leader/delegate-task/execute.sh" \
  '{"to":"quinn-target","task":"Contract test delegation","from":"quinn-tl"}' >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/add")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/add POST captured for team-leader/delegate-task"
else
  assert_add_contract "tl-delegate-task" "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 6 — orchestrator/delegate-task -> /task-pool/add
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 6: orchestrator/delegate-task -> /add ---"
: > "$LOG"
# The orc delegate-task skill enforces the Request Contract (P0-3): the brief
# must carry Goal + Expected Outcome + Eval Criteria markers or it refuses.
bash "${REPO_ROOT}/config/skills/orchestrator/delegate-task/execute.sh" \
  '{"to":"quinn-target","task":"Goal: contract test orc delegation. Expected Outcome: a /task-pool/add body is emitted. Eval Criteria: body shape matches CreateWorkItemInput."}' \
  >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/add")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/add POST captured for orchestrator/delegate-task"
else
  assert_add_contract "orc-delegate-task" "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 7 — agent/core/break-down-request -> /task-pool/add
#
# This callsite deliberately uses the LEGACY FULL shape (id + status +
# createdAt) so its client-side ids can be referenced upfront. It is the
# control case: the contract must accept the legacy path, not just minimal.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 7: agent/core/break-down-request -> /add (legacy full shape) ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/break-down-request/execute.sh" \
  '{"requestId":"req-contract-1","sessionName":"quinn-bdr","tasks":[{"title":"Contract subtask","description":"d","type":"delegate","target":"quinn-target"}]}' \
  >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/add")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/add POST captured for break-down-request"
else
  assert_add_contract "break-down-request" "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 8 — team-leader/decompose-goal -> /task-pool/add
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 8: team-leader/decompose-goal -> /add ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/team-leader/decompose-goal/execute.sh" \
  '{"objective":"Contract test objective","projectPath":"/tmp/proj-foo","tasks":[{"title":"Contract subtask","description":"d","requiredRole":"developer","priority":"high"}]}' \
  >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/add")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/add POST captured for team-leader/decompose-goal"
else
  assert_add_contract "decompose-goal" "$BODY"
  assert_jq "decompose-goal: priority preserved in metadata.priority" '.metadata.priority != null' "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 9 — agent/core/block-task -> /task-pool/block/:id
#
# This callsite sent {reason, questions?, urgency?} and NO agentId, so every
# call 400'd with "agentId is required" — the skill agents use to report being
# blocked could not report anything. `questions`/`urgency` had no field on the
# endpoint and were discarded; they are now folded into `reason`, which is read.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 9: agent/core/block-task -> /block ---"
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/block-task/execute.sh" \
  '{"workItemId":"wi-stub-1","sessionName":"quinn-blocker","reason":"missing creds","urgency":"high","questions":"who owns X?"}' \
  >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/block/wi-stub-1")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/block POST captured for block-task"
else
  assert_block_contract "block-task" "$BODY"
  assert_jq "block-task: urgency folded into reason, not dropped" '.reason | test("urgency")' "$BODY"
  assert_jq "block-task: questions folded into reason, not dropped" '.reason | test("who owns X")' "$BODY"
fi

# ---------------------------------------------------------------------------
# Scenario 10 — create-task carries a brief (instance 10)
#
# create-task previously sent only {title,type,owner,target,metadata}, so every
# WorkItem filed through the documented skill was TITLE-ONLY — an agent could
# not attach Goal + Expected Outcome + Eval Criteria at all. `description` and
# `briefMarkdown` are both CreateWorkItemInput fields the endpoint reads.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 10: create-task carries description + briefMarkdown ---"
: > "$LOG"
BRIEF_FILE=$(mktemp)
printf '## GOAL\nShip the thing.\n\n## EVAL CRITERIA\n1. It ships.\n' > "$BRIEF_FILE"
bash "${REPO_ROOT}/config/skills/agent/core/create-task/execute.sh" \
  --project-path /tmp/proj-foo --task "Briefed task" \
  --description "A short summary" --brief "@${BRIEF_FILE}" >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/add")
if [ -z "$BODY" ]; then
  FAIL=$((FAIL + 1)); echo "  ✗ no /task-pool/add POST captured for briefed create-task"
else
  assert_add_contract "create-task(briefed)" "$BODY"
  assert_jq "create-task: description forwarded" '.description == "A short summary"' "$BODY"
  assert_jq "create-task: briefMarkdown forwarded from @file" '.briefMarkdown | test("EVAL CRITERIA")' "$BODY"
fi
rm -f "$BRIEF_FILE"

# Omitting both must still produce a clean minimal WorkItem — no empty strings.
: > "$LOG"
bash "${REPO_ROOT}/config/skills/agent/core/create-task/execute.sh" \
  --project-path /tmp/proj-foo --task "Unbriefed task" >/dev/null 2>&1 || true
BODY=$(capture "/api/task-pool/add")
if [ -n "$BODY" ]; then
  assert_jq "create-task: omits description entirely when unset" 'has("description") == false' "$BODY"
  assert_jq "create-task: omits briefMarkdown entirely when unset" 'has("briefMarkdown") == false' "$BODY"
fi

# Over-cap brief must fail IN THE SKILL, naming the limit — not reach the server.
: > "$LOG"
BIG_FILE=$(mktemp)
python3 -c "import sys; sys.stdout.write('x' * 17000)" > "$BIG_FILE"
BIG_OUT=$(bash "${REPO_ROOT}/config/skills/agent/core/create-task/execute.sh" \
  --project-path /tmp/proj-foo --task "Oversized" --brief "@${BIG_FILE}" 2>&1 || true)
if printf '%s' "$BIG_OUT" | grep -q "16384"; then
  PASS=$((PASS + 1)); echo "  ✓ create-task: over-cap brief rejected naming the 16384-byte limit"
else
  FAIL=$((FAIL + 1)); echo "  ✗ create-task: expected a 16384-byte limit error, got: ${BIG_OUT}"
fi
if grep -qF '"path": "/api/task-pool/add"' "$LOG"; then
  FAIL=$((FAIL + 1)); echo "  ✗ create-task: over-cap brief still hit the server — must fail before the POST"
else
  PASS=$((PASS + 1)); echo "  ✓ create-task: over-cap brief never reached the server"
fi
rm -f "$BIG_FILE"

# ---------------------------------------------------------------------------
# Scenario 11 — block-task pre-checks status instead of letting the state
# machine answer with a bare conflict.
#
# WORK_ITEM_TRANSITIONS allows `blocked` only from `running`. Blocking a queued
# item previously surfaced as a raw HTTP 500 carrying a state-machine string —
# a CLIENT error dressed as a server fault, which makes retry logic treat a
# PERMANENT failure as transient.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 11: block-task status pre-check ---"
: > "$LOG"
echo "queued" > "${LOG}.status"
PRECHECK_OUT=$(bash "${REPO_ROOT}/config/skills/agent/core/block-task/execute.sh" \
  '{"workItemId":"wi-stub-1","sessionName":"quinn-blocker","reason":"missing creds"}' 2>&1 || true)
rm -f "${LOG}.status"

if printf '%s' "$PRECHECK_OUT" | grep -q "not 'running'"; then
  PASS=$((PASS + 1)); echo "  ✓ refuses a queued item, naming its actual status"
else
  FAIL=$((FAIL + 1)); echo "  ✗ expected a status refusal, got: ${PRECHECK_OUT}"
fi

if printf '%s' "$PRECHECK_OUT" | grep -q "accept-task"; then
  PASS=$((PASS + 1)); echo "  ✓ names the remedy skill rather than the state machine"
else
  FAIL=$((FAIL + 1)); echo "  ✗ refusal does not tell the caller how to proceed"
fi

if grep -qF '"path": "/api/task-pool/block/' "$LOG"; then
  FAIL=$((FAIL + 1)); echo "  ✗ called /block anyway — the pre-check must short-circuit"
else
  PASS=$((PASS + 1)); echo "  ✓ no /block POST emitted"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
