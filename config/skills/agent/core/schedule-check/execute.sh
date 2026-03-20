#!/bin/bash
# Schedule a future check-in reminder for yourself (#233)
# Agents can self-schedule recurring tasks without routing through orchestrator
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"minutes\":20,\"message\":\"Run supervision check\",\"recurring\":true}'"

MINUTES=$(echo "$INPUT" | jq -r '.minutes // empty')
MESSAGE=$(echo "$INPUT" | jq -r '.message // empty')
RECURRING=$(echo "$INPUT" | jq -r '.recurring // false')
MAX_OCCURRENCES=$(echo "$INPUT" | jq -r '.maxOccurrences // empty')
require_param "minutes" "$MINUTES"
require_param "message" "$MESSAGE"

# Default target to the calling agent's own session
TARGET_SESSION="${CREWLY_SESSION_NAME:-}"
[ -z "$TARGET_SESSION" ] && error_exit "CREWLY_SESSION_NAME not set — cannot determine target session"

if [ "$RECURRING" = "true" ]; then
  BODY=$(jq -n --arg target "$TARGET_SESSION" --arg minutes "$MINUTES" --arg message "$MESSAGE" \
    '{targetSession: $target, minutes: ($minutes | tonumber), intervalMinutes: ($minutes | tonumber), message: $message, isRecurring: true}')
  if [ -n "$MAX_OCCURRENCES" ]; then
    BODY=$(echo "$BODY" | jq --arg max "$MAX_OCCURRENCES" '. + {maxOccurrences: ($max | tonumber)}')
  fi
else
  BODY=$(jq -n --arg target "$TARGET_SESSION" --arg minutes "$MINUTES" --arg message "$MESSAGE" \
    '{targetSession: $target, minutes: ($minutes | tonumber), message: $message}')
fi

api_call POST "/schedule" "$BODY"
