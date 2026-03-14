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
# #150: Task type classification — 'technical' tasks can bypass PM routing
TASK_TYPE=$(echo "$INPUT" | jq -r '.taskType // "general"')
# #180: Cross-team validation
TEAM_ID=$(echo "$INPUT" | jq -r '.teamId // empty')
FORCE_CROSS_TEAM=$(echo "$INPUT" | jq -r '.forceCrossTeam // "false"')
require_param "to" "$TO"
require_param "task" "$TASK"

# #180: Validate target agent belongs to the specified team
if [ -n "$TEAM_ID" ] && [ "$FORCE_CROSS_TEAM" != "true" ]; then
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
  MEMBER_SESSION=$(echo "$TEAM_DATA" | jq -r --arg to "$TO" '.data.members[]? | select(.sessionName == $to) | .sessionName // empty' 2>/dev/null || true)
  if [ -z "$MEMBER_SESSION" ]; then
    echo "{\"success\":false,\"error\":\"Cross-team delegation blocked: ${TO} is not a member of team ${TEAM_ID}. Use forceCrossTeam:true to override.\"}"
    exit 1
  fi
fi

# #182: Technical task routing — if taskType=technical and target is PM with a TL,
# auto-redirect to the TL to skip PM middleman latency
if [ "$TASK_TYPE" = "technical" ] && [ -n "$TEAM_ID" ]; then
  TARGET_ROLE=$(echo "$TEAM_DATA" | jq -r --arg to "$TO" '.data.members[]? | select(.sessionName == $to) | .role // empty' 2>/dev/null || true)
  if [ "$TARGET_ROLE" = "product-manager" ]; then
    # Find TL in the same team
    TL_SESSION=$(echo "$TEAM_DATA" | jq -r '.data.members[]? | select(.role == "team-leader" or .canDelegate == true) | .sessionName // empty' 2>/dev/null | head -1 || true)
    if [ -n "$TL_SESSION" ]; then
      echo "{\"info\":\"Technical task redirected from PM (${TO}) to TL (${TL_SESSION})\"}" >&2
      TO="$TL_SESSION"
    fi
  fi
fi

# Structured message parameters (for hierarchical teams)
TITLE=$(echo "$INPUT" | jq -r '.title // empty')
PARENT_TASK_ID=$(echo "$INPUT" | jq -r '.parentTaskId // empty')
EXPECTED_ARTIFACTS=$(echo "$INPUT" | jq -c '.expectedArtifacts // empty')
CONTEXT_FILES=$(echo "$INPUT" | jq -c '.contextFiles // empty')
DEADLINE_HINT=$(echo "$INPUT" | jq -r '.deadlineHint // empty')
USE_STRUCTURED=$(echo "$INPUT" | jq -r '.structured // "false"')

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

# Build the task message
# If structured=true and title is provided, use the [TASK ASSIGNMENT] format
# Otherwise, use the legacy free-text format for backwards compatibility
DELEGATOR="${CREWLY_SESSION_NAME:-crewly-orc}"

if [ "$USE_STRUCTURED" = "true" ] && [ -n "$TITLE" ]; then
  # Structured TaskAssignment format for hierarchical teams
  TASK_MESSAGE="---\n[TASK ASSIGNMENT]\nTask ID: ${TASK_ID:-pending}\nTitle: ${TITLE}\nPriority: ${PRIORITY}\nDelegated by: ${DELEGATOR}\nParent Task: ${PARENT_TASK_ID:-none}\n---\n\n## Instructions\n${TASK}"

  # Add expected artifacts if provided
  if [ -n "$EXPECTED_ARTIFACTS" ] && [ "$EXPECTED_ARTIFACTS" != "" ]; then
    ARTIFACT_LIST=$(echo "$EXPECTED_ARTIFACTS" | jq -r '.[]? // empty' 2>/dev/null | while read -r a; do echo "- ${a}"; done)
    if [ -n "$ARTIFACT_LIST" ]; then
      TASK_MESSAGE="${TASK_MESSAGE}\n\n## Expected Deliverables\n${ARTIFACT_LIST}"
    fi
  fi

  # Add context files if provided
  if [ -n "$CONTEXT_FILES" ] && [ "$CONTEXT_FILES" != "" ]; then
    FILE_LIST=$(echo "$CONTEXT_FILES" | jq -r '.[]? // empty' 2>/dev/null | while read -r f; do echo "- ${f}"; done)
    if [ -n "$FILE_LIST" ]; then
      TASK_MESSAGE="${TASK_MESSAGE}\n\n## Context\nRead these files first:\n${FILE_LIST}"
    fi
  fi

  [ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nAdditional context: ${CONTEXT}"
  [ -n "$DEADLINE_HINT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\n**Deadline hint**: ${DEADLINE_HINT}"
  TASK_MESSAGE="${TASK_MESSAGE}\n\n---\nWhen done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\",\"projectPath\":\"${PROJECT_PATH}\"}'"
  TASK_MESSAGE="${TASK_MESSAGE}\n\nBefore reporting done, persist key findings using: bash ${CREWLY_ROOT}/config/skills/agent/core/remember/execute.sh '{\"agentId\":\"${TO}\",\"content\":\"<key findings>\",\"category\":\"pattern\",\"scope\":\"project\"}'"
else
  # Legacy free-text format (backwards compatible)
  TASK_MESSAGE="New task from orchestrator (priority: ${PRIORITY}):\n\n${TASK}"
  [ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nContext: ${CONTEXT}"
  TASK_MESSAGE="${TASK_MESSAGE}\n\nWhen done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\",\"projectPath\":\"${PROJECT_PATH}\"}'"
  TASK_MESSAGE="${TASK_MESSAGE}\n\nBefore reporting done, persist key findings using: bash ${CREWLY_ROOT}/config/skills/agent/core/remember/execute.sh '{\"agentId\":\"${TO}\",\"content\":\"<key findings>\",\"category\":\"pattern\",\"scope\":\"project\"}'"
fi

# Deliver the task message with fallback strategy:
# 1. Try reliable delivery with waitForReady (15s timeout)
# 2. If agent not ready, fall back to force mode (direct PTY write)
# 3. If both fail, output error to stdout (so orchestrator can see it) and exit 1
BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 15000}')

DELIVER_OK=true
api_call POST "/terminal/${TO}/deliver" "$BODY" || DELIVER_OK=false

if [ "$DELIVER_OK" = "false" ]; then
  # Agent not ready or session not found — retry with force mode (direct PTY write)
  FORCE_BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, force: true}')
  api_call POST "/terminal/${TO}/deliver" "$FORCE_BODY" || {
    # Both delivery attempts failed — output error to stdout for orchestrator visibility
    echo '{"error":"Failed to deliver task to '"$TO"'. Session may not exist or agent is not running."}'
    exit 1
  }
fi

# Track the task file path and task ID from create response for monitoring linkage
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

  # Deliver a follow-up message with complete-task instructions now that taskPath is known (#137).
  # This ensures agents call complete-task with the exact path, not just report-status.
  if [ -n "$TASK_FILE_PATH" ]; then
    COMPLETE_INSTR="After finishing and calling report-status, also run: bash ${CREWLY_ROOT}/config/skills/agent/core/complete-task/execute.sh '{\"absoluteTaskPath\":\"${TASK_FILE_PATH}\",\"sessionName\":\"${TO}\",\"summary\":\"<brief summary>\"}'"
    FOLLOWUP_BODY=$(jq -n --arg message "$COMPLETE_INSTR" '{message: $message, force: true}')
    api_call POST "/terminal/${TO}/deliver" "$FOLLOWUP_BODY" 2>/dev/null || true
  fi
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
    --arg taskId "$TASK_ID" \
    '{targetSession: $target, minutes: ($minutes | tonumber), intervalMinutes: ($minutes | tonumber), message: $message, isRecurring: true} + (if $taskId != "" then {taskId: $taskId} else {} end)' 2>/dev/null) || true
  [ -n "$SCHED_BODY" ] && SCHED_RESULT=$(api_call POST "/schedule" "$SCHED_BODY" 2>/dev/null || true)
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
