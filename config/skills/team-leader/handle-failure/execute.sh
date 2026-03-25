#!/bin/bash
# Decide the next action when a worker task fails.
# Decision logic: retry (retries < 2) → reassign (skill mismatch) → escalate (resource/permission)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workerId\":\"worker-1\",\"workerSession\":\"worker-session\",\"teamId\":\"team-123\",\"failureInfo\":{\"error\":\"tests failed\",\"failedSteps\":[\"tests\"],\"retries\":0,\"failureType\":\"verification\"},\"requiredRole\":\"developer\"}'"

WORKER_ID=$(printf '%s' "$INPUT" | jq -r '.workerId // empty')
WORKER_SESSION=$(printf '%s' "$INPUT" | jq -r '.workerSession // empty')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
REQUIRED_ROLE=$(printf '%s' "$INPUT" | jq -r '.requiredRole // empty')
TASK_DESCRIPTION=$(printf '%s' "$INPUT" | jq -r '.taskDescription // empty')

# Failure info
RETRIES=$(printf '%s' "$INPUT" | jq -r '.failureInfo.retries // 0')
FAILURE_TYPE=$(printf '%s' "$INPUT" | jq -r '.failureInfo.failureType // "unknown"')
ERROR_MSG=$(printf '%s' "$INPUT" | jq -r '.failureInfo.error // "Unknown error"')
FAILED_STEPS=$(printf '%s' "$INPUT" | jq -c '.failureInfo.failedSteps // []')

require_param "workerId" "$WORKER_ID"

# Decision logic
ACTION=""
NEXT_WORKER_ID=""
NEXT_WORKER_SESSION=""
INSTRUCTIONS=""

# Rule 1: If retries < 2 and failure is recoverable → retry
if [ "$RETRIES" -lt 2 ]; then
  case "$FAILURE_TYPE" in
    verification|format|test_failure)
      ACTION="retry"
      INSTRUCTIONS="Retry attempt $((RETRIES + 1))/2. Previous failure: ${ERROR_MSG}. Please fix the issues in the failed steps and try again."
      ;;
    pty_error|session_error)
      ACTION="retry"
      INSTRUCTIONS="Session error detected. Retrying after recovery. Previous error: ${ERROR_MSG}"
      ;;
    skill_mismatch)
      # Skill mismatch goes directly to reassign
      ACTION="reassign"
      INSTRUCTIONS="Task requires skills that ${WORKER_ID} does not have."
      ;;
    resource_error|permission_error|budget_error)
      # Resource/permission issues escalate immediately
      ACTION="escalate"
      INSTRUCTIONS="Resource or permission issue cannot be resolved at TL level: ${ERROR_MSG}"
      ;;
    *)
      # Unknown failure types: retry if under limit
      ACTION="retry"
      INSTRUCTIONS="Retry attempt $((RETRIES + 1))/2. Error: ${ERROR_MSG}. Please investigate and try a different approach."
      ;;
  esac
else
  # Rule 2: Retries exhausted → try reassign, then escalate
  ACTION="reassign"
  INSTRUCTIONS="Worker ${WORKER_ID} failed after ${RETRIES} retries. Reassigning to another worker."
fi

# If action is reassign, find an alternative worker
if [ "$ACTION" = "reassign" ] && [ -n "$TEAM_ID" ]; then
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
  TEAM_SUCCESS=$(echo "$TEAM_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")

  if [ "$TEAM_SUCCESS" = "true" ]; then
    # Find another worker with matching role, excluding the failed worker
    if [ -n "$REQUIRED_ROLE" ]; then
      ALT_WORKER=$(echo "$TEAM_DATA" | jq -r --arg role "$REQUIRED_ROLE" --arg excludeId "$WORKER_ID" \
        '[.data.members[] | select(.role == $role and .id != $excludeId and .agentStatus == "active")] | first | .id // empty' 2>/dev/null || true)
      ALT_SESSION=$(echo "$TEAM_DATA" | jq -r --arg role "$REQUIRED_ROLE" --arg excludeId "$WORKER_ID" \
        '[.data.members[] | select(.role == $role and .id != $excludeId and .agentStatus == "active")] | first | .sessionName // empty' 2>/dev/null || true)
    else
      # No specific role required, find any active non-leader worker
      ALT_WORKER=$(echo "$TEAM_DATA" | jq -r --arg excludeId "$WORKER_ID" \
        '[.data.members[] | select(.id != $excludeId and .role != "team-leader" and .agentStatus == "active")] | first | .id // empty' 2>/dev/null || true)
      ALT_SESSION=$(echo "$TEAM_DATA" | jq -r --arg excludeId "$WORKER_ID" \
        '[.data.members[] | select(.id != $excludeId and .role != "team-leader" and .agentStatus == "active")] | first | .sessionName // empty' 2>/dev/null || true)
    fi

    if [ -n "$ALT_WORKER" ]; then
      NEXT_WORKER_ID="$ALT_WORKER"
      NEXT_WORKER_SESSION="$ALT_SESSION"
      INSTRUCTIONS="Reassigning from ${WORKER_ID} to ${ALT_WORKER}. Previous worker failed after ${RETRIES} retries: ${ERROR_MSG}"
    else
      # No alternative worker found → escalate
      ACTION="escalate"
      INSTRUCTIONS="No alternative worker available for reassignment. Original worker ${WORKER_ID} failed after ${RETRIES} retries: ${ERROR_MSG}. Escalating to Orchestrator."
    fi
  else
    # Cannot fetch team data → escalate
    ACTION="escalate"
    INSTRUCTIONS="Cannot validate team members for reassignment. Escalating to Orchestrator. Error: ${ERROR_MSG}"
  fi
fi

# Output decision
jq -n \
  --arg action "$ACTION" \
  --arg nextWorkerId "$NEXT_WORKER_ID" \
  --arg nextWorkerSession "$NEXT_WORKER_SESSION" \
  --arg instructions "$INSTRUCTIONS" \
  --arg originalWorkerId "$WORKER_ID" \
  --arg failureType "$FAILURE_TYPE" \
  --arg retries "$RETRIES" \
  '{
    action: $action,
    nextWorkerId: (if $nextWorkerId != "" then $nextWorkerId else null end),
    nextWorkerSession: (if $nextWorkerSession != "" then $nextWorkerSession else null end),
    instructions: $instructions,
    context: {
      originalWorkerId: $originalWorkerId,
      failureType: $failureType,
      retriesSoFar: ($retries | tonumber)
    }
  }'
