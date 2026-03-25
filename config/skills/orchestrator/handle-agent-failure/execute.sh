#!/bin/bash
# Notify the orchestrator about an agent failure so it can take recovery actions (#129)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"agentSession\":\"agent-dev-1\",\"reason\":\"runtime_exited\",\"hadActiveTasks\":true}'"

AGENT_SESSION=$(printf '%s' "$INPUT" | jq -r '.agentSession // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // "unknown"')
HAD_ACTIVE_TASKS=$(printf '%s' "$INPUT" | jq -r '.hadActiveTasks // false')
TASK_SUMMARY=$(printf '%s' "$INPUT" | jq -r '.taskSummary // empty')
RESTART_ATTEMPTED=$(printf '%s' "$INPUT" | jq -r '.restartAttempted // false')
RESTART_SUCCEEDED=$(printf '%s' "$INPUT" | jq -r '.restartSucceeded // false')
require_param "agentSession" "$AGENT_SESSION"

# Build a structured notification message for the orchestrator
MESSAGE="Agent failure notification: ${AGENT_SESSION} became inactive.\nReason: ${REASON}"

if [ "$HAD_ACTIVE_TASKS" = "true" ]; then
  MESSAGE="${MESSAGE}\nThe agent had active tasks in progress."
  [ -n "$TASK_SUMMARY" ] && MESSAGE="${MESSAGE}\nTask: ${TASK_SUMMARY}"
fi

if [ "$RESTART_ATTEMPTED" = "true" ]; then
  if [ "$RESTART_SUCCEEDED" = "true" ]; then
    MESSAGE="${MESSAGE}\nAutomatic restart succeeded — agent is recovering."
  else
    MESSAGE="${MESSAGE}\nAutomatic restart FAILED — manual intervention needed."
    MESSAGE="${MESSAGE}\n\nPlease take one of the following actions:"
    MESSAGE="${MESSAGE}\n1. Restart the agent and re-delegate the task"
    MESSAGE="${MESSAGE}\n2. Reassign the task to another available agent"
    MESSAGE="${MESSAGE}\n3. Inform the user about the failure"
  fi
else
  MESSAGE="${MESSAGE}\nNo automatic restart was attempted."
  MESSAGE="${MESSAGE}\n\nPlease decide whether to restart the agent or reassign its tasks."
fi

# Send the notification to the orchestrator via the chat API
BODY=$(jq -n --arg content "$MESSAGE" --arg senderName "system" \
  '{content: $content, senderName: $senderName, senderType: "system"}')

api_call POST "/chat/agent-response" "$BODY"
