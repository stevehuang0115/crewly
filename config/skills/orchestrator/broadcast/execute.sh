#!/bin/bash
# Broadcast a message to all active agent sessions
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"message\":\"Team standup in 5 minutes\"}'"

MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
require_param "message" "$MESSAGE"

# Get all active sessions
SESSIONS=$(api_call GET "/terminal/sessions" 2>/dev/null) || error_exit "Failed to get sessions"

# Extract session names and send to each
NAMES=$(echo "$SESSIONS" | jq -r '.data // . | if type == "array" then .[].name else empty end' 2>/dev/null)

RESULTS="[]"
SENT=0
FAILED=0

for NAME in $NAMES; do
  # Skip orchestrator's own session
  [ "$NAME" = "crewly-orc" ] && continue

  BODY=$(jq -n --arg message "$MESSAGE" '{message: $message}')
  if api_call POST "/terminal/${NAME}/deliver" "$BODY" >/dev/null 2>&1; then
    SENT=$((SENT + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

echo "{\"sent\":${SENT},\"failed\":${FAILED},\"message\":\"Broadcast complete\"}"
