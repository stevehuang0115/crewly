#!/bin/bash
# Delegate a task to a worker within this Team Leader's subordinate scope.
# Validates hierarchy (worker.parentMemberId == TL.memberId) before delegation.
# Reuses the orchestrator delegate-task delivery and monitoring logic.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"to\":\"worker-session\",\"task\":\"implement feature X\",\"priority\":\"high\",\"teamId\":\"team-123\",\"tlMemberId\":\"tl-member-id\",\"projectPath\":\"/path/to/project\"}'"

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

# Resolve Crewly root from this script path:
# config/skills/team-leader/delegate-task/execute.sh -> project root
CREWLY_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# Validate hierarchy: check that target worker belongs to this TL
if [ -n "$TEAM_ID" ] && [ -n "$TL_MEMBER_ID" ]; then
  # Fetch team data to validate hierarchy
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
  TEAM_SUCCESS=$(echo "$TEAM_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")

  if [ "$TEAM_SUCCESS" = "true" ]; then
    # Find the target worker by session name and check parentMemberId
    WORKER_PARENT=$(echo "$TEAM_DATA" | jq -r --arg session "$TO" \
      '.data.members[] | select(.sessionName == $session) | .parentMemberId // empty' 2>/dev/null || true)

    if [ -n "$WORKER_PARENT" ] && [ "$WORKER_PARENT" != "$TL_MEMBER_ID" ]; then
      error_exit "Hierarchy violation: worker ${TO} (parentMemberId=${WORKER_PARENT}) is not a subordinate of TL ${TL_MEMBER_ID}"
    fi
  fi
fi

# Resolve skill paths to absolute paths
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

# Build a structured task message from Team Leader
TASK_MESSAGE="New task from Team Leader (priority: ${PRIORITY}):\n\n**[REQUIRED] When done, you MUST:** (1) Output a text summary of your work, findings, and any issues. (2) Call report-status:\nbash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\",\"projectPath\":\"${PROJECT_PATH}\"}'\n\n---\n\n${TASK}"
[ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nContext: ${CONTEXT}"

# Deliver the task message with fallback strategy
BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 15000}')

DELIVER_OK=true
api_call POST "/terminal/${TO}/deliver" "$BODY" || DELIVER_OK=false

if [ "$DELIVER_OK" = "false" ]; then
  FORCE_BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, force: true}')
  api_call POST "/terminal/${TO}/deliver" "$FORCE_BODY" || {
    echo '{"error":"Failed to deliver task to '"$TO"'. Session may not exist or agent is not running."}'
    exit 1
  }
fi

# Track the task file path and task ID from create response
TASK_FILE_PATH=""
TASK_ID=""

# Create task file in project's .crewly/tasks/ directory
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

# Set up idle event subscription for TL monitoring
MONITOR_IDLE=$(echo "$INPUT" | jq -r 'if .monitor.idleEvent == null then true else .monitor.idleEvent end')
MONITOR_FALLBACK_MINUTES=$(echo "$INPUT" | jq -r 'if .monitor.fallbackCheckMinutes == null then 5 else .monitor.fallbackCheckMinutes end')

COLLECTED_SCHEDULE_IDS="[]"
COLLECTED_SUBSCRIPTION_IDS="[]"

# Resolve the delegating TL's session name for event/schedule routing.
# Priority: (1) CREWLY_SESSION_NAME env var, (2) fromSession in input JSON.
# If neither is available, skip monitoring gracefully instead of crashing.
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

# Store monitoring IDs for auto-cleanup
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
