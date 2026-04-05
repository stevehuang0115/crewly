#!/bin/bash
# Tests for handoff-task execute.sh
# Covers: required params, task file metadata append, safe JSON output,
#         orchestrator notification, sessionName fallback, API calls
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

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

# Extract the final JSON object from mixed stdout+stderr output.
# The mock script may emit stderr lines before the final JSON.
extract_json() {
  # Pipe all output, use jq -s to find the last valid JSON object on stdout
  local raw="$1"
  # Try to parse the whole thing as JSON first (happy path)
  echo "$raw" | jq -c 'select(.success)' 2>/dev/null | tail -1 && return 0
  # Fallback: grab lines that look like JSON
  echo "$raw" | grep -E '^\{' | jq -c '.' 2>/dev/null | tail -1 && return 0
  echo '{}'
}

# Create mock wrapper that intercepts api_call
MOCK_DIR=$(mktemp -d)
MOCK_SCRIPT="$MOCK_DIR/run_handoff.sh"
API_LOG="$MOCK_DIR/api_calls.log"
touch "$API_LOG"

cat > "$MOCK_SCRIPT" << 'MOCK_EOF'
#!/bin/bash
# Mock wrapper for handoff-task — overrides api_call, then inlines real logic.
set -euo pipefail

REAL_SKILL_DIR="$1"
shift

# Load shared lib
source "${REAL_SKILL_DIR}/../../_common/lib.sh"

API_LOG="${MOCK_API_LOG:-/tmp/handoff_api_calls.log}"

# Override api_call with mock
api_call() {
  local method="$1" endpoint="$2" body="${3:-}"
  echo "${method} ${endpoint}" >> "$API_LOG"

  case "${method} ${endpoint}" in
    "POST /task-management/handoff")
      echo '{"success":true,"handoff":{"from":"mock","to":"mock","taskId":"t-123"}}'
      ;;
    *)
      echo '{"success":true}'
      ;;
  esac
  return 0
}

# Override auto_remember
auto_remember() {
  echo "POST /memory/remember" >> "$API_LOG"
}

export CREWLY_ROOT="$(cd "${REAL_SKILL_DIR}/../../../.." && pwd)"

# --- Inline the handoff-task logic ---
INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"from-agent\",\"to\":\"target-session\",\"reason\":\"...\"}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.taskPath // .absoluteTaskPath // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // "Task handoff"')
PROGRESS=$(printf '%s' "$INPUT" | jq -r '.progress // empty')
FINDINGS=$(printf '%s' "$INPUT" | jq -r '.findings // empty')
BLOCKERS=$(printf '%s' "$INPUT" | jq -r '.blockers // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

[ -z "$SESSION_NAME" ] && SESSION_NAME="${CREWLY_SESSION_NAME:-}"

require_param "sessionName" "$SESSION_NAME"
require_param "to" "$TO"
require_param "reason" "$REASON"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Step 1: Record handoff via API
HANDOFF_BODY=$(jq -n \
  --arg from "$SESSION_NAME" \
  --arg to "$TO" \
  --arg taskPath "${TASK_PATH:-}" \
  --arg reason "$REASON" \
  --arg progress "${PROGRESS:-}" \
  --arg projectPath "${PROJECT_PATH:-}" \
  '{from: $from, to: $to, taskPath: $taskPath, reason: $reason, progress: $progress, projectPath: $projectPath}')
handoff_result=$(api_call POST "/task-management/handoff" "$HANDOFF_BODY" 2>/dev/null) || handoff_result='{"tracked":false}'

# Step 2: Append to task file
if [ -n "$TASK_PATH" ] && [ -f "$TASK_PATH" ]; then
  cat >> "$TASK_PATH" << HANDOFF_EOF

## Handoff Record
- **Handed off to**: ${TO}
- **Handed off from**: ${SESSION_NAME}
- **Reason**: ${REASON}
- **Timestamp**: ${TIMESTAMP}
HANDOFF_EOF
  [ -n "$PROGRESS" ] && printf '\n### Progress at Handoff\n%s\n' "$PROGRESS" >> "$TASK_PATH"
  [ -n "$FINDINGS" ] && printf '\n### Key Findings\n%s\n' "$FINDINGS" >> "$TASK_PATH"
  [ -n "$BLOCKERS" ] && printf '\n### Blockers\n%s\n' "$BLOCKERS" >> "$TASK_PATH"
fi

# Step 3: Deliver context to target
DELIVER_BODY=$(jq -n --arg data "[TASK HANDOFF] from ${SESSION_NAME}" --arg mode "message" '{data: $data, mode: $mode}')
deliver_result=$(api_call POST "/terminal/${TO}/write" "$DELIVER_BODY" 2>/dev/null) || deliver_result='{"error":"delivery failed"}'

# Step 4: Notify orchestrator
NOTIFY_BODY=$(jq -n --arg content "[HANDOFF] ${SESSION_NAME} → ${TO}: ${REASON}" --arg senderName "$SESSION_NAME" \
  '{content: $content, senderName: $senderName, senderType: "agent"}')
api_call POST "/chat/agent-response" "$NOTIFY_BODY" >/dev/null 2>&1 || true

# Step 5: Output result (compact single-line for easy test parsing)
jq -c -n \
  --arg from "$SESSION_NAME" \
  --arg to "$TO" \
  --arg reason "$REASON" \
  --arg taskPath "${TASK_PATH:-}" \
  --arg timestamp "$TIMESTAMP" \
  --argjson delivery "$(echo "$deliver_result" | jq -c '.' 2>/dev/null || echo '{}')" \
  --argjson tracking "$(echo "$handoff_result" | jq -c '.' 2>/dev/null || echo '{}')" \
  '{success:true, handoff:{from:$from, to:$to, reason:$reason, taskPath:(if $taskPath == "" then null else $taskPath end), timestamp:$timestamp}, delivery:$delivery, tracking:$tracking}'

# Step 6: Persist knowledge
auto_remember "$SESSION_NAME" "[HANDOFF] from ${SESSION_NAME} to ${TO}: ${REASON}" "fact" "project" "$PROJECT_PATH"
MOCK_EOF
chmod +x "$MOCK_SCRIPT"

echo "=== handoff-task tests ==="

# Helper: run mock and extract the compact JSON line from stdout only
run_mock() {
  local out
  # Capture stdout separately from stderr
  out=$(env "$@" 2>/dev/null) || true
  # The last line of stdout should be the compact JSON
  echo "$out" | grep -E '^\{.*"success"' | tail -1
}

# -----------------------------------------------------------------------
# Scenario 1: Successful handoff with all parameters
# -----------------------------------------------------------------------
echo "Scenario 1: Full handoff with all parameters"
> "$API_LOG"
TASK_FILE="$MOCK_DIR/test-task-1.md"
echo "# Original Task" > "$TASK_FILE"

JSON_OUTPUT=$(run_mock MOCK_API_LOG="$API_LOG" \
  bash "$MOCK_SCRIPT" "$SCRIPT_DIR" \
  "{\"sessionName\":\"agent-a\",\"to\":\"agent-b\",\"taskPath\":\"$TASK_FILE\",\"reason\":\"Blocked on infra\",\"progress\":\"70% done\",\"findings\":\"Need shared util\",\"blockers\":\"VPN access\",\"projectPath\":\"/tmp/project\"}")

if echo "$JSON_OUTPUT" | jq -e '.success == true' > /dev/null 2>&1; then
  echo "  PASS: handoff returns success"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected success=true (output: $JSON_OUTPUT)"
  FAIL=$((FAIL + 1))
fi

FROM_OUT=$(echo "$JSON_OUTPUT" | jq -r '.handoff.from')
TO_OUT=$(echo "$JSON_OUTPUT" | jq -r '.handoff.to')
if [ "$FROM_OUT" = "agent-a" ] && [ "$TO_OUT" = "agent-b" ]; then
  echo "  PASS: from/to correct in output"
  PASS=$((PASS + 1))
else
  echo "  FAIL: from=$FROM_OUT to=$TO_OUT (expected agent-a, agent-b)"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 2: Task file gets handoff metadata appended
# -----------------------------------------------------------------------
echo "Scenario 2: Task file metadata appended"
if grep -q "Handed off to.*agent-b" "$TASK_FILE"; then
  echo "  PASS: task file contains handoff-to metadata"
  PASS=$((PASS + 1))
else
  echo "  FAIL: task file missing handoff-to metadata"
  FAIL=$((FAIL + 1))
fi

if grep -q "Progress at Handoff" "$TASK_FILE"; then
  echo "  PASS: task file contains progress section"
  PASS=$((PASS + 1))
else
  echo "  FAIL: task file missing progress section"
  FAIL=$((FAIL + 1))
fi

if grep -q "Key Findings" "$TASK_FILE"; then
  echo "  PASS: task file contains findings section"
  PASS=$((PASS + 1))
else
  echo "  FAIL: task file missing findings section"
  FAIL=$((FAIL + 1))
fi

if grep -q "Blockers" "$TASK_FILE"; then
  echo "  PASS: task file contains blockers section"
  PASS=$((PASS + 1))
else
  echo "  FAIL: task file missing blockers section"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 3: API calls are made correctly
# -----------------------------------------------------------------------
echo "Scenario 3: Correct API calls made"
if grep -q "POST /task-management/handoff" "$API_LOG"; then
  echo "  PASS: task-management/handoff API called"
  PASS=$((PASS + 1))
else
  echo "  FAIL: task-management/handoff API not called"
  FAIL=$((FAIL + 1))
fi

if grep -q "POST /terminal/agent-b/write" "$API_LOG"; then
  echo "  PASS: terminal write API called for target agent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: terminal write API not called"
  FAIL=$((FAIL + 1))
fi

if grep -q "POST /chat/agent-response" "$API_LOG"; then
  echo "  PASS: orchestrator notified via chat API"
  PASS=$((PASS + 1))
else
  echo "  FAIL: orchestrator not notified"
  FAIL=$((FAIL + 1))
fi

if grep -q "POST /memory/remember" "$API_LOG"; then
  echo "  PASS: knowledge persisted via auto_remember"
  PASS=$((PASS + 1))
else
  echo "  FAIL: knowledge not persisted"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 4: Missing required params fail
# -----------------------------------------------------------------------
echo "Scenario 4: Missing required params"
assert_fails "fails without 'to'" \
  env -u CREWLY_SESSION_NAME MOCK_API_LOG="$API_LOG" bash "$MOCK_SCRIPT" "$SCRIPT_DIR" \
  '{"sessionName":"agent-a","reason":"blocked"}'

assert_fails "fails without 'sessionName' and no env var" \
  env -u CREWLY_SESSION_NAME MOCK_API_LOG="$API_LOG" bash "$MOCK_SCRIPT" "$SCRIPT_DIR" \
  '{"to":"agent-b","reason":"blocked"}'

assert_fails "fails with empty input" \
  env -u CREWLY_SESSION_NAME MOCK_API_LOG="$API_LOG" bash "$MOCK_SCRIPT" "$SCRIPT_DIR" ''

# -----------------------------------------------------------------------
# Scenario 5: sessionName from CREWLY_SESSION_NAME env var fallback
# -----------------------------------------------------------------------
echo "Scenario 5: CREWLY_SESSION_NAME fallback"
> "$API_LOG"
JSON_OUTPUT=$(run_mock CREWLY_SESSION_NAME="env-agent" MOCK_API_LOG="$API_LOG" \
  bash "$MOCK_SCRIPT" "$SCRIPT_DIR" \
  '{"to":"agent-b","reason":"env fallback test"}')
FROM_OUT=$(echo "$JSON_OUTPUT" | jq -r '.handoff.from' 2>/dev/null)
if [ "$FROM_OUT" = "env-agent" ]; then
  echo "  PASS: sessionName resolved from CREWLY_SESSION_NAME"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected from=env-agent, got from=$FROM_OUT"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 6: Explicit sessionName overrides CREWLY_SESSION_NAME
# -----------------------------------------------------------------------
echo "Scenario 6: Explicit sessionName takes precedence"
> "$API_LOG"
JSON_OUTPUT=$(run_mock CREWLY_SESSION_NAME="env-agent" MOCK_API_LOG="$API_LOG" \
  bash "$MOCK_SCRIPT" "$SCRIPT_DIR" \
  '{"sessionName":"explicit-agent","to":"agent-b","reason":"override test"}')
FROM_OUT=$(echo "$JSON_OUTPUT" | jq -r '.handoff.from' 2>/dev/null)
if [ "$FROM_OUT" = "explicit-agent" ]; then
  echo "  PASS: explicit sessionName overrides env var"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected from=explicit-agent, got from=$FROM_OUT"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 7: Handoff without task file (no file append)
# -----------------------------------------------------------------------
echo "Scenario 7: Handoff without task file"
> "$API_LOG"
JSON_OUTPUT=$(run_mock MOCK_API_LOG="$API_LOG" \
  bash "$MOCK_SCRIPT" "$SCRIPT_DIR" \
  '{"sessionName":"agent-a","to":"agent-b","reason":"no file test"}')
TASK_PATH_OUT=$(echo "$JSON_OUTPUT" | jq -r '.handoff.taskPath' 2>/dev/null)
if [ "$TASK_PATH_OUT" = "null" ]; then
  echo "  PASS: taskPath is null when not provided"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected taskPath=null, got $TASK_PATH_OUT"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Scenario 8: JSON output is valid (no string interpolation breakage)
# -----------------------------------------------------------------------
echo "Scenario 8: Safe JSON output with special characters"
> "$API_LOG"
JSON_OUTPUT=$(run_mock MOCK_API_LOG="$API_LOG" \
  bash "$MOCK_SCRIPT" "$SCRIPT_DIR" \
  '{"sessionName":"agent-a","to":"agent-b","reason":"Has quotes and $vars and (parens)"}')
if echo "$JSON_OUTPUT" | jq -e '.success == true' > /dev/null 2>&1; then
  echo "  PASS: output is valid JSON with special chars in reason"
  PASS=$((PASS + 1))
else
  echo "  FAIL: output is not valid JSON (output: $JSON_OUTPUT)"
  FAIL=$((FAIL + 1))
fi

# Cleanup
rm -rf "$MOCK_DIR"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
