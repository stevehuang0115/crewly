#!/bin/bash
# Report task status to the orchestrator
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"dev-1\",\"status\":\"done\",\"summary\":\"...\"}' or echo '{...}' | execute.sh"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
STATUS=$(printf '%s' "$INPUT" | jq -r '.status // empty')
SUMMARY=$(printf '%s' "$INPUT" | jq -r '.summary // empty')
TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.taskPath // empty')
require_param "sessionName" "$SESSION_NAME"
require_param "status" "$STATUS"
require_param "summary" "$SUMMARY"

# Optional structured StatusReport fields (for hierarchical workflows)
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.taskId // empty')
PROGRESS=$(printf '%s' "$INPUT" | jq -r '.progress // empty')
ARTIFACTS=$(printf '%s' "$INPUT" | jq -c '.artifacts // empty')
BLOCKERS=$(printf '%s' "$INPUT" | jq -c '.blockers // empty')
USE_STRUCTURED=$(printf '%s' "$INPUT" | jq -r '.structured // "false"')

# Map simple status strings to InProgressTaskStatus values
map_status_to_state() {
  case "$1" in
    done|completed) echo "completed" ;;
    blocked) echo "blocked" ;;
    failed) echo "failed" ;;
    in_progress|working) echo "working" ;;
    *) echo "$1" ;;
  esac
}

# Build the message the orchestrator will receive
if [ "$USE_STRUCTURED" = "true" ] && [ -n "$TASK_ID" ]; then
  # Structured StatusReport format for hierarchical teams
  STATE=$(map_status_to_state "$STATUS")
  MESSAGE="---\n[STATUS REPORT]\nTask ID: ${TASK_ID}\nState: ${STATE}"
  [ -n "$PROGRESS" ] && MESSAGE="${MESSAGE}\nProgress: ${PROGRESS}%"
  MESSAGE="${MESSAGE}\nReported by: ${SESSION_NAME}\n---\n\n## Status\n${SUMMARY}"

  # Add artifacts if provided
  if [ -n "$ARTIFACTS" ] && [ "$ARTIFACTS" != "" ]; then
    ARTIFACT_LINES=$(echo "$ARTIFACTS" | jq -r '.[]? | "- **\(.name)** (\(.type)): \(.content)"' 2>/dev/null || true)
    if [ -n "$ARTIFACT_LINES" ]; then
      MESSAGE="${MESSAGE}\n\n## Artifacts\n${ARTIFACT_LINES}"
    fi
  fi

  # Add blockers if provided
  if [ -n "$BLOCKERS" ] && [ "$BLOCKERS" != "" ]; then
    BLOCKER_LINES=$(echo "$BLOCKERS" | jq -r '.[]? // empty' 2>/dev/null | while read -r b; do echo "- ${b}"; done)
    if [ -n "$BLOCKER_LINES" ]; then
      MESSAGE="${MESSAGE}\n\n## Blockers\n${BLOCKER_LINES}"
    fi
  fi
else
  # Legacy format (backwards compatible)
  STATUS_UPPER=$(echo "$STATUS" | tr '[:lower:]' '[:upper:]')
  MESSAGE="[${STATUS_UPPER}] Agent ${SESSION_NAME}: ${SUMMARY}"
fi

# Send the status message to the orchestrator session via the chat API
BODY=$(jq -n --arg content "$MESSAGE" --arg senderName "$SESSION_NAME" \
  '{content: $content, senderName: $senderName, senderType: "agent"}')

api_call POST "/chat/agent-response" "$BODY"

# Auto-register as active when reporting "active" or first status.
# This ensures the agent's agentStatus transitions from "started" to "active"
# in storage, which the queue processor requires before delivering messages.
# Without this, agents that call report-status instead of register-self
# remain stuck in "started" state indefinitely.

# If task is done and taskPath provided, move task file to done folder
if [ "$STATUS" = "done" ] && [ -n "$TASK_PATH" ]; then
  COMPLETE_BODY=$(jq -n \
    --arg taskPath "$TASK_PATH" \
    --arg sessionName "$SESSION_NAME" \
    '{taskPath: $taskPath, sessionName: $sessionName}')
  api_call POST "/task-management/complete" "$COMPLETE_BODY" || true
fi

# Auto-complete tracked tasks when status is done
if [ "$STATUS" = "done" ]; then
  SESSION_BODY=$(jq -n --arg sessionName "$SESSION_NAME" '{sessionName: $sessionName}')
  api_call POST "/task-management/complete-by-session" "$SESSION_BODY" || true
fi

# Auto-persist key findings as project knowledge when task is done (#127, #219).
# Use [COMPLETED] prefix so recall can distinguish completed tasks from other patterns.
# This prevents PM from re-delegating tasks that were already done.
if [ "$STATUS" = "done" ] && [ -n "$SUMMARY" ]; then
  PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  auto_remember "$SESSION_NAME" "[COMPLETED] Task completed by ${SESSION_NAME}: ${SUMMARY}" "decision" "project" "$PROJECT_PATH"
fi
