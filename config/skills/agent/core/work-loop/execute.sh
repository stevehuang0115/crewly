#!/bin/bash
# =============================================================================
# work-loop — Hybrid pull+push work loop for V3 agents
#
# This skill implements the agent's idle-time work acquisition loop.
# When an agent has no active task, it:
#   1. Checks for V2 push-mode tasks (get-my-tasks for delegated/assigned work)
#   2. Polls the V3 Task Pool for claimable work items
#   3. If a task is claimed, returns it for execution
#   4. If no work found, returns idle status
#
# This is the HYBRID bridge between V2 (push) and V3 (pull). Both
# mechanisms coexist — the agent tries push first, then pull.
#
# Usage:
#   bash execute.sh '{"sessionName":"agent-1","role":"developer","projectPath":"/path/to/project"}'
#
# Parameters:
#   sessionName  (required) — Agent session name
#   role         (optional) — Agent role for capability matching
#   skills       (optional) — JSON array of skill tags
#   projectPath  (optional) — Project path for task lookup and memory
#
# Returns:
#   Found work: { success: true, hasWork: true, source: "v2"|"v3", task|workItem: {...} }
#   No work:    { success: true, hasWork: false, message: "..." }
#   Error:      { error: "..." }
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-1\",\"role\":\"developer\"}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

ROLE=$(printf '%s' "$INPUT" | jq -r '.role // empty')
SKILLS_JSON=$(printf '%s' "$INPUT" | jq -c '.skills // []')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

# ---------------------------------------------------------------------------
# Step 1: Check V2 push-mode tasks (delegated tasks assigned to this agent)
# ---------------------------------------------------------------------------

V2_TASKS_SCRIPT="${SCRIPT_DIR}/../get-my-tasks/execute.sh"

if [ -f "$V2_TASKS_SCRIPT" ]; then
  V2_PARAMS=$(jq -n \
    --arg sessionName "$SESSION_NAME" \
    --arg projectPath "$PROJECT_PATH" \
    '{sessionName: $sessionName, projectPath: $projectPath}')

  V2_RESULT=$(bash "$V2_TASKS_SCRIPT" "$V2_PARAMS" 2>/dev/null) || V2_RESULT='{"tasks":[]}'

  # Check for in_progress or assigned tasks
  V2_ACTIVE=$(printf '%s' "$V2_RESULT" | jq -c '
    [.tasks // [] | .[] | select(.status == "in_progress" or .status == "assigned" or .status == "open")]
    | first // null
  ' 2>/dev/null || echo "null")

  if [ "$V2_ACTIVE" != "null" ] && [ -n "$V2_ACTIVE" ]; then
    TASK_NAME=$(printf '%s' "$V2_ACTIVE" | jq -r '.name // "unknown"')
    jq -n \
      --argjson task "$V2_ACTIVE" \
      --arg taskName "$TASK_NAME" \
      '{
        success: true,
        hasWork: true,
        source: "v2",
        message: ("Found V2 push-mode task: " + $taskName),
        task: $task
      }'
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: Poll V3 Task Pool for claimable work items
# ---------------------------------------------------------------------------

POLL_SCRIPT="${SCRIPT_DIR}/../poll-tasks/execute.sh"

if [ -f "$POLL_SCRIPT" ]; then
  POLL_PARAMS=$(jq -n \
    --arg sessionName "$SESSION_NAME" \
    --arg role "$ROLE" \
    --argjson skills "$SKILLS_JSON" \
    --arg projectPath "$PROJECT_PATH" \
    '{sessionName: $sessionName, role: $role, skills: $skills, projectPath: $projectPath}')

  POLL_RESULT=$(bash "$POLL_SCRIPT" "$POLL_PARAMS" 2>/dev/null) || POLL_RESULT='{"success":false}'

  CLAIMED=$(printf '%s' "$POLL_RESULT" | jq -r '.claimed // false')

  if [ "$CLAIMED" = "true" ]; then
    WORK_ITEM=$(printf '%s' "$POLL_RESULT" | jq -c '.workItem // null')
    CLAIM_OBJ=$(printf '%s' "$POLL_RESULT" | jq -c '.claim // null')
    WORK_ITEM_ID=$(printf '%s' "$POLL_RESULT" | jq -r '.workItemId // "unknown"')
    CLAIM_ID=$(printf '%s' "$POLL_RESULT" | jq -r '.claimId // "unknown"')

    jq -n \
      --argjson workItem "$WORK_ITEM" \
      --argjson claim "$CLAIM_OBJ" \
      --arg workItemId "$WORK_ITEM_ID" \
      --arg claimId "$CLAIM_ID" \
      '{
        success: true,
        hasWork: true,
        source: "v3",
        message: "Claimed work item from Task Pool",
        workItemId: $workItemId,
        claimId: $claimId,
        workItem: $workItem,
        claim: $claim
      }'
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: No work found — report idle
# ---------------------------------------------------------------------------

jq -n '{
  success: true,
  hasWork: false,
  message: "No work available from V2 push or V3 pull. Agent is idle."
}'
