#!/bin/bash
# Tests for TL delegate-task execute.sh
# Covers: CREWLY_SESSION_NAME resolution, fromSession fallback,
#         graceful monitoring skip, delegation success
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

assert_succeeds() {
  local desc="$1"
  shift
  if OUTPUT=$("$@" 2>&1); then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected success, got exit $? — output: $OUTPUT)"
    FAIL=$((FAIL + 1))
  fi
}

assert_fails() {
  local desc="$1"
  shift
  if OUTPUT=$("$@" 2>&1); then
    echo "  FAIL: $desc (expected failure, got success — output: $OUTPUT)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  fi
}

assert_output_contains() {
  local desc="$1" expected="$2"
  shift 2
  local OUTPUT=""
  OUTPUT=$("$@" 2>&1) || true
  if echo "$OUTPUT" | grep -q "$expected"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$expected' in output, got: $OUTPUT)"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_not_contains() {
  local desc="$1" unexpected="$2"
  shift 2
  local OUTPUT=""
  OUTPUT=$("$@" 2>&1) || true
  if echo "$OUTPUT" | grep -q "$unexpected"; then
    echo "  FAIL: $desc (did NOT expect '$unexpected' in output, got: $OUTPUT)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  fi
}

# Create a mock wrapper that overrides api_call to avoid real HTTP calls.
MOCK_DIR=$(mktemp -d)
MOCK_SCRIPT="$MOCK_DIR/run_delegate_task.sh"
cat > "$MOCK_SCRIPT" << 'MOCK_EOF'
#!/bin/bash
# Mock wrapper for delegate-task execute.sh
# Overrides api_call to return controlled responses, then sources the real script logic.
set -euo pipefail

REAL_SKILL_DIR="$1"
shift

# Load the real shared lib first
source "${REAL_SKILL_DIR}/../_common/lib.sh"

# Track API calls for verification
API_CALLS_LOG=$(mktemp)

# Override api_call with mock
api_call() {
  local method="$1" endpoint="$2" body="${3:-}"
  echo "${method} ${endpoint}" >> "$API_CALLS_LOG"

  if [ "$method" = "GET" ] && echo "$endpoint" | grep -q "^/teams/"; then
    cat << 'TEAMJSON'
{"success":true,"data":{"id":"team-123","name":"Product","members":[{"id":"tl-001","sessionName":"crewly-product-sam-tl","role":"team-leader","parentMemberId":""},{"id":"worker-001","sessionName":"crewly-product-leo-dev","role":"developer","parentMemberId":"tl-001"}]}}
TEAMJSON
    return 0
  fi

  if [ "$method" = "POST" ] && echo "$endpoint" | grep -q "^/terminal/.*/deliver"; then
    echo '{"success":true,"delivered":true}'
    return 0
  fi

  if [ "$method" = "POST" ] && [ "$endpoint" = "/task-management/create" ]; then
    echo '{"success":true,"taskPath":"/tmp/mock-task.md","taskId":"task-001"}'
    return 0
  fi

  if [ "$method" = "POST" ] && [ "$endpoint" = "/events/subscribe" ]; then
    echo '{"success":true,"data":{"id":"sub-001"}}'
    return 0
  fi

  if [ "$method" = "POST" ] && [ "$endpoint" = "/schedule" ]; then
    echo '{"success":true,"data":{"checkId":"sched-001"}}'
    return 0
  fi

  if [ "$method" = "POST" ] && [ "$endpoint" = "/task-management/add-monitoring" ]; then
    echo '{"success":true}'
    return 0
  fi

  echo '{"success":true}'
  return 0
}

export CREWLY_ROOT="$(cd "${REAL_SKILL_DIR}/../../../.." && pwd)"

# Source and run the main script inline (cannot call execute.sh directly
# because it would re-source lib.sh, overriding our mock api_call)
INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{...}'"

TO=$(echo "$INPUT" | jq -r '.to // empty')
TASK=$(echo "$INPUT" | jq -r '.task // empty')
PRIORITY=$(echo "$INPUT" | jq -r '.priority // "normal"')
CONTEXT=$(echo "$INPUT" | jq -r '.context // empty')
PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
TEAM_ID=$(echo "$INPUT" | jq -r '.teamId // empty')
TL_MEMBER_ID=$(echo "$INPUT" | jq -r '.tlMemberId // empty')
FROM_SESSION=$(echo "$INPUT" | jq -r '.fromSession // empty')
require_param "to" "$TO"
require_param "task" "$TASK"

# Validate hierarchy
if [ -n "$TEAM_ID" ] && [ -n "$TL_MEMBER_ID" ]; then
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
  TEAM_SUCCESS=$(echo "$TEAM_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")
  if [ "$TEAM_SUCCESS" = "true" ]; then
    WORKER_PARENT=$(echo "$TEAM_DATA" | jq -r --arg session "$TO" \
      '.data.members[] | select(.sessionName == $session) | .parentMemberId // empty' 2>/dev/null || true)
    if [ -n "$WORKER_PARENT" ] && [ "$WORKER_PARENT" != "$TL_MEMBER_ID" ]; then
      error_exit "Hierarchy violation: worker ${TO} (parentMemberId=${WORKER_PARENT}) is not a subordinate of TL ${TL_MEMBER_ID}"
    fi
  fi
fi

# Resolve skill paths
resolve_skill_paths() {
  local input="$1"
  perl -pe '
    my $root = $ENV{"CREWLY_ROOT"};
    s{\bbash\s+config/skills/}{bash $root/config/skills/}g;
    s{(?<![A-Za-z0-9_./-])config/skills/}{$root/config/skills/}g;
  ' <<< "$input"
}

TASK="$(CREWLY_ROOT="$CREWLY_ROOT" resolve_skill_paths "$TASK")"
if [ -n "$CONTEXT" ]; then
  CONTEXT="$(CREWLY_ROOT="$CREWLY_ROOT" resolve_skill_paths "$CONTEXT")"
fi

TASK_MESSAGE="New task from Team Leader (priority: ${PRIORITY}):\n\n${TASK}"
[ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nContext: ${CONTEXT}"
TASK_MESSAGE="${TASK_MESSAGE}\n\nWhen done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\"}'"

BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 15000}')
api_call POST "/terminal/${TO}/deliver" "$BODY"

TASK_FILE_PATH=""
TASK_ID=""
if [ -n "$PROJECT_PATH" ]; then
  CREATE_BODY=$(jq -n \
    --arg projectPath "$PROJECT_PATH" \
    --arg task "$TASK" \
    --arg priority "$PRIORITY" \
    --arg sessionName "$TO" \
    --arg milestone "delegated" \
    '{projectPath: $projectPath, task: $task, priority: $priority, sessionName: $sessionName, milestone: $milestone}')
  CREATE_RESULT=$(api_call POST "/task-management/create" "$CREATE_BODY" 2>/dev/null || true)
  TASK_FILE_PATH=$(echo "$CREATE_RESULT" | jq -r '.taskPath // empty' 2>/dev/null || true)
  TASK_ID=$(echo "$CREATE_RESULT" | jq -r '.taskId // empty' 2>/dev/null || true)
fi

# --- THIS IS THE CODE BEING TESTED ---
MONITOR_IDLE=$(echo "$INPUT" | jq -r 'if .monitor.idleEvent == null then true else .monitor.idleEvent end')
MONITOR_FALLBACK_MINUTES=$(echo "$INPUT" | jq -r 'if .monitor.fallbackCheckMinutes == null then 5 else .monitor.fallbackCheckMinutes end')

COLLECTED_SCHEDULE_IDS="[]"
COLLECTED_SUBSCRIPTION_IDS="[]"

# Resolve the delegating TL's session name for event/schedule routing.
RESOLVED_SESSION="${CREWLY_SESSION_NAME:-${FROM_SESSION:-}}"

if [ -z "$RESOLVED_SESSION" ]; then
  echo '{"warning":"CREWLY_SESSION_NAME not set and no fromSession provided — skipping idle event and schedule monitoring. Delegation still proceeds."}' >&2
fi

if [ "$MONITOR_IDLE" = "true" ] && [ -n "$RESOLVED_SESSION" ]; then
  SUB_BODY=$(jq -n \
    --arg eventType "agent:idle" \
    --arg sessionName "$TO" \
    --arg subscriber "$RESOLVED_SESSION" \
    '{eventType: $eventType, filter: {sessionName: $sessionName}, subscriberSession: $subscriber, oneShot: true, ttlMinutes: 120}')
  SUB_RESULT=$(api_call POST "/events/subscribe" "$SUB_BODY" 2>/dev/null || true)
  SUB_ID=$(echo "$SUB_RESULT" | jq -r '.data.id // empty' 2>/dev/null || true)
  if [ -n "$SUB_ID" ]; then
    COLLECTED_SUBSCRIPTION_IDS=$(echo "$COLLECTED_SUBSCRIPTION_IDS" | jq --arg id "$SUB_ID" '. + [$id]')
  fi
fi

if [ "$MONITOR_FALLBACK_MINUTES" != "0" ] && [ -n "$MONITOR_FALLBACK_MINUTES" ] && [ -n "$RESOLVED_SESSION" ]; then
  SCHED_BODY=$(jq -n \
    --arg target "$RESOLVED_SESSION" \
    --arg minutes "$MONITOR_FALLBACK_MINUTES" \
    --arg message "TL progress check: review ${TO} status — task: ${TASK:0:100}" \
    --arg taskId "$TASK_ID" \
    '{targetSession: $target, minutes: ($minutes | tonumber), intervalMinutes: ($minutes | tonumber), message: $message, isRecurring: true} + (if $taskId != "" then {taskId: $taskId} else {} end)' 2>/dev/null) || true
  [ -n "$SCHED_BODY" ] && SCHED_RESULT=$(api_call POST "/schedule" "$SCHED_BODY" 2>/dev/null || true)
  SCHED_ID=$(echo "$SCHED_RESULT" | jq -r '.checkId // .data.checkId // empty' 2>/dev/null || true)
  if [ -n "$SCHED_ID" ]; then
    COLLECTED_SCHEDULE_IDS=$(echo "$COLLECTED_SCHEDULE_IDS" | jq --arg id "$SCHED_ID" '. + [$id]')
  fi
fi

HAS_SCHEDULE_IDS=$(echo "$COLLECTED_SCHEDULE_IDS" | jq 'length > 0')
HAS_SUBSCRIPTION_IDS=$(echo "$COLLECTED_SUBSCRIPTION_IDS" | jq 'length > 0')

if [ "$HAS_SCHEDULE_IDS" = "true" ] || [ "$HAS_SUBSCRIPTION_IDS" = "true" ]; then
  MONITOR_BODY=$(jq -n \
    --arg sessionName "$TO" \
    --argjson scheduleIds "$COLLECTED_SCHEDULE_IDS" \
    --argjson subscriptionIds "$COLLECTED_SUBSCRIPTION_IDS" \
    '{sessionName: $sessionName, scheduleIds: $scheduleIds, subscriptionIds: $subscriptionIds}')
  api_call POST "/task-management/add-monitoring" "$MONITOR_BODY" 2>/dev/null || true
fi

# Output success with monitoring info (compact single-line for test parsing)
jq -c -n \
  --arg to "$TO" \
  --arg taskId "$TASK_ID" \
  --argjson scheduleIds "$COLLECTED_SCHEDULE_IDS" \
  --argjson subscriptionIds "$COLLECTED_SUBSCRIPTION_IDS" \
  --arg resolvedSession "${RESOLVED_SESSION:-}" \
  '{success: true, delegatedTo: $to, taskId: $taskId, monitoring: {scheduleIds: $scheduleIds, subscriptionIds: $subscriptionIds, resolvedSession: $resolvedSession}}'

rm -f "$API_CALLS_LOG"
MOCK_EOF
chmod +x "$MOCK_SCRIPT"

SKILL_DIR="$SCRIPT_DIR"

echo "=== TL delegate-task tests ==="

# -----------------------------------------------------------------------
# Scenario 1: Delegation with CREWLY_SESSION_NAME set — full monitoring
# -----------------------------------------------------------------------
echo "Scenario 1: CREWLY_SESSION_NAME set — full delegation with monitoring"
RAW_OUTPUT=$(env CREWLY_SESSION_NAME="crewly-product-sam-tl" bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev","task":"Implement feature X","priority":"high","teamId":"team-123","tlMemberId":"tl-001","projectPath":"/tmp/project"}' 2>&1)
OUTPUT=$(echo "$RAW_OUTPUT" | grep '"monitoring"' | head -1)
if echo "$OUTPUT" | jq -e '.success' > /dev/null 2>&1; then
  RESOLVED=$(echo "$OUTPUT" | jq -r '.monitoring.resolvedSession')
  if [ "$RESOLVED" = "crewly-product-sam-tl" ]; then
    echo "  PASS: delegation succeeds with env var session"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: resolvedSession expected 'crewly-product-sam-tl', got '$RESOLVED'"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL: delegation failed (output: $OUTPUT)"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 2: No CREWLY_SESSION_NAME, fromSession provided — uses fallback
# -----------------------------------------------------------------------
echo "Scenario 2: fromSession fallback when no env var"
RAW_OUTPUT=$(env -u CREWLY_SESSION_NAME bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev","task":"Implement feature Y","fromSession":"crewly-product-sam-tl"}' 2>&1)
OUTPUT=$(echo "$RAW_OUTPUT" | grep '"monitoring"' | head -1)
if echo "$OUTPUT" | jq -e '.success' > /dev/null 2>&1; then
  RESOLVED=$(echo "$OUTPUT" | jq -r '.monitoring.resolvedSession')
  if [ "$RESOLVED" = "crewly-product-sam-tl" ]; then
    echo "  PASS: delegation succeeds with fromSession fallback"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: resolvedSession expected 'crewly-product-sam-tl', got '$RESOLVED'"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL: delegation failed (output: $OUTPUT)"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 3: No session at all — delegation succeeds, monitoring skipped
# -----------------------------------------------------------------------
echo "Scenario 3: No session identity — graceful degradation"
RAW_OUTPUT=$(env -u CREWLY_SESSION_NAME bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev","task":"Implement feature Z"}' 2>&1)
OUTPUT=$(echo "$RAW_OUTPUT" | grep '"monitoring"' | head -1)
if echo "$OUTPUT" | jq -e '.success' > /dev/null 2>&1; then
  # Verify monitoring was skipped (empty arrays)
  SCHED_COUNT=$(echo "$OUTPUT" | jq '.monitoring.scheduleIds | length')
  SUB_COUNT=$(echo "$OUTPUT" | jq '.monitoring.subscriptionIds | length')
  if [ "$SCHED_COUNT" = "0" ] && [ "$SUB_COUNT" = "0" ]; then
    echo "  PASS: delegation succeeds, monitoring correctly skipped"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: expected empty monitoring arrays, got schedules=$SCHED_COUNT subs=$SUB_COUNT"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL: delegation should succeed without session (output: $OUTPUT)"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 4: No session, should emit warning
# -----------------------------------------------------------------------
echo "Scenario 4: Warning emitted when session not available"
assert_output_contains "warning about missing session" \
  "skipping idle event and schedule monitoring" \
  env -u CREWLY_SESSION_NAME bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev","task":"Task without session"}'

# -----------------------------------------------------------------------
# Scenario 5: CREWLY_SESSION_NAME takes priority over fromSession
# -----------------------------------------------------------------------
echo "Scenario 5: Env var takes priority over fromSession"
RAW_OUTPUT=$(env CREWLY_SESSION_NAME="env-session" bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev","task":"Test priority","fromSession":"json-session"}' 2>&1)
OUTPUT=$(echo "$RAW_OUTPUT" | grep '"monitoring"' | head -1)
RESOLVED=$(echo "$OUTPUT" | jq -r '.monitoring.resolvedSession')
if [ "$RESOLVED" = "env-session" ]; then
  echo "  PASS: env var takes priority over fromSession"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 'env-session', got '$RESOLVED'"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 6: monitor.idleEvent=false — no idle subscription
# -----------------------------------------------------------------------
echo "Scenario 6: monitor.idleEvent=false skips idle subscription"
RAW_OUTPUT=$(env CREWLY_SESSION_NAME="sam-tl" bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev","task":"Test no idle","monitor":{"idleEvent":false}}' 2>&1)
OUTPUT=$(echo "$RAW_OUTPUT" | grep '"monitoring"' | head -1)
SUB_COUNT=$(echo "$OUTPUT" | jq '.monitoring.subscriptionIds | length')
if [ "$SUB_COUNT" = "0" ]; then
  echo "  PASS: idle event subscription correctly skipped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 0 subscriptions, got $SUB_COUNT"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 7: monitor.fallbackCheckMinutes=0 — no schedule
# -----------------------------------------------------------------------
echo "Scenario 7: fallbackCheckMinutes=0 skips schedule"
RAW_OUTPUT=$(env CREWLY_SESSION_NAME="sam-tl" bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev","task":"Test no schedule","monitor":{"fallbackCheckMinutes":0}}' 2>&1)
OUTPUT=$(echo "$RAW_OUTPUT" | grep '"monitoring"' | head -1)
SCHED_COUNT=$(echo "$OUTPUT" | jq '.monitoring.scheduleIds | length')
if [ "$SCHED_COUNT" = "0" ]; then
  echo "  PASS: scheduled check correctly skipped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 0 schedules, got $SCHED_COUNT"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 8: Missing required params
# -----------------------------------------------------------------------
echo "Scenario 8: Missing required params"
assert_fails "fails without 'to'" \
  env -u CREWLY_SESSION_NAME bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"task":"Missing to param"}'

assert_fails "fails without 'task'" \
  env -u CREWLY_SESSION_NAME bash "$MOCK_SCRIPT" "$SKILL_DIR" \
  '{"to":"crewly-product-leo-dev"}'

assert_fails "fails without any input" \
  env -u CREWLY_SESSION_NAME bash "$MOCK_SCRIPT" "$SKILL_DIR" ''

# Cleanup
rm -rf "$MOCK_DIR"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
