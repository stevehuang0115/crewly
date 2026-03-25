#!/bin/bash
# Resume a Claude Code agent's most recent conversation session
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-session\"}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

# Step 1: Send /resume command to the agent's session
BODY=$(jq -n --arg message "/resume" '{message: $message}')
api_call POST "/terminal/${SESSION_NAME}/deliver" "$BODY"

# Step 2: Wait for Claude Code to render the session picker
sleep 3

# Step 3: Send Enter to select the most recent (first) session
KEY_BODY=$(jq -n '{key: "Enter"}')
api_call POST "/terminal/${SESSION_NAME}/key" "$KEY_BODY"
