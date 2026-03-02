#!/bin/bash
# Delegate a task to an agent with a structured task template.
# Optionally sets up auto-monitoring (idle event subscription + fallback schedule)
# that will be cleaned up automatically when the task completes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"to\":\"agent-session\",\"task\":\"implement feature X\",\"priority\":\"high\",\"projectPath\":\"/path/to/project\",\"monitor\":{\"idleEvent\":true,\"fallbackCheckMinutes\":5}}'"

TO=$(echo "$INPUT" | jq -r '.to // empty')
TASK=$(echo "$INPUT" | jq -r '.task // empty')
PRIORITY=$(echo "$INPUT" | jq -r '.priority // "normal"')
CONTEXT=$(echo "$INPUT" | jq -r '.context // empty')
PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
require_param "to" "$TO"
require_param "task" "$TASK"

# Monitor parameters — enabled by default to ensure proactive progress notifications.
# Use explicit null-check so that `false` / `0` are respected as opt-out values,
# while omitted fields default to enabled (idleEvent=true, fallbackCheckMinutes=5).
MONITOR_IDLE=$(echo "$INPUT" | jq -r 'if .monitor.idleEvent == null then true else .monitor.idleEvent end')
MONITOR_FALLBACK_MINUTES=$(echo "$INPUT" | jq -r 'if .monitor.fallbackCheckMinutes == null then 5 else .monitor.fallbackCheckMinutes end')

# Resolve Crewly root from this script path:
# config/skills/orchestrator/delegate-task/execute.sh -> project root
CREWLY_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

resolve_skill_paths() {
  local input="$1"
  # Convert "bash config/skills/..." and "/config/skills/..." to absolute paths.
  # This keeps delegated instructions runnable when agents use different CWDs.
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

# Build a structured task message
TASK_MESSAGE="New task from orchestrator (priority: ${PRIORITY}):\n\n${TASK}"
[ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nContext: ${CONTEXT}"
TASK_MESSAGE="${TASK_MESSAGE}\n\nWhen done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\"}'"

# waitTimeout matches EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT (120000ms)
BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 120000}')

api_call POST "/terminal/${TO}/deliver" "$BODY"

# Track the task file path from create response for monitoring linkage
TASK_FILE_PATH=""

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
fi

# --- Auto-monitoring setup ---
# Collect IDs for monitoring cleanup linkage
COLLECTED_SCHEDULE_IDS="[]"
COLLECTED_SUBSCRIPTION_IDS="[]"

# Set up idle event subscription if requested
if [ "$MONITOR_IDLE" = "true" ]; then
  SUBSCRIBER_SESSION="${CREWLY_SESSION_NAME:-crewly-orc}"
  SUB_BODY=$(jq -n \
    --arg eventType "agent:idle" \
    --arg sessionName "$TO" \
    --arg subscriber "$SUBSCRIBER_SESSION" \
    '{eventType: $eventType, filter: {sessionName: $sessionName}, subscriberSession: $subscriber, oneShot: true, ttlMinutes: 120}')
  SUB_RESULT=$(api_call POST "/events/subscribe" "$SUB_BODY" 2>/dev/null || true)
  SUB_ID=$(echo "$SUB_RESULT" | jq -r '.data.id // empty' 2>/dev/null || true)
  if [ -n "$SUB_ID" ]; then
    COLLECTED_SUBSCRIPTION_IDS=$(echo "$COLLECTED_SUBSCRIPTION_IDS" | jq --arg id "$SUB_ID" '. + [$id]')
  fi
fi

# Set up fallback recurring schedule if requested
if [ "$MONITOR_FALLBACK_MINUTES" != "0" ] && [ -n "$MONITOR_FALLBACK_MINUTES" ]; then
  SCHEDULE_TARGET="${CREWLY_SESSION_NAME:-crewly-orc}"
  SCHED_BODY=$(jq -n \
    --arg target "$SCHEDULE_TARGET" \
    --arg minutes "$MONITOR_FALLBACK_MINUTES" \
    --arg message "Progress check: review ${TO} status — task: ${TASK:0:100}" \
    '{targetSession: $target, minutes: ($minutes | tonumber), intervalMinutes: ($minutes | tonumber), message: $message, isRecurring: true}')
  SCHED_RESULT=$(api_call POST "/schedule" "$SCHED_BODY" 2>/dev/null || true)
  SCHED_ID=$(echo "$SCHED_RESULT" | jq -r '.checkId // .data.checkId // empty' 2>/dev/null || true)
  if [ -n "$SCHED_ID" ]; then
    COLLECTED_SCHEDULE_IDS=$(echo "$COLLECTED_SCHEDULE_IDS" | jq --arg id "$SCHED_ID" '. + [$id]')
  fi
fi

# Store monitoring IDs for auto-cleanup if we have any
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
