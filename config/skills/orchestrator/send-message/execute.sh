#!/bin/bash
# Send a message to an agent's terminal session.
# Supports: argument, stdin pipe, or @filepath for JSON input (#292, #293).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-session\",\"message\":\"hello\"}' or echo '{...}' | execute.sh"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
FORCE=$(printf '%s' "$INPUT" | jq -r '.force // empty')
require_param "sessionName" "$SESSION_NAME"
require_param "message" "$MESSAGE"

# force=true: write directly to PTY without waiting for agent prompt.
# Use when the agent is busy and you need immediate delivery.
if [ "$FORCE" = "true" ]; then
  BODY=$(jq -n --arg message "$MESSAGE" '{message: $message, force: true}')
else
  # waitTimeout matches EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT (120000ms)
  BODY=$(jq -n --arg message "$MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 120000}')
fi

api_call POST "/terminal/${SESSION_NAME}/deliver" "$BODY"
