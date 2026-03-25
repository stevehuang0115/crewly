#!/bin/bash
# Schedule a future check-in reminder (Team Leader version).
# Validates that the target is self or a subordinate worker.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"minutes\":5,\"message\":\"Check worker progress\",\"teamId\":\"team-123\",\"tlMemberId\":\"tl-id\",\"sessionName\":\"my-session\"}'"

MINUTES=$(printf '%s' "$INPUT" | jq -r '.minutes // empty')
MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
TARGET=$(printf '%s' "$INPUT" | jq -r '.target // empty')
RECURRING=$(printf '%s' "$INPUT" | jq -r '.recurring // false')
MAX_OCCURRENCES=$(printf '%s' "$INPUT" | jq -r '.maxOccurrences // empty')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
TL_MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.tlMemberId // empty')
# sessionName: explicit caller identity, used as fallback when CREWLY_SESSION_NAME is not set
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "minutes" "$MINUTES"
require_param "message" "$MESSAGE"

# Resolve caller identity: env var > input param
CALLER_SESSION="${CREWLY_SESSION_NAME:-${SESSION_NAME}}"

# Default target to the caller's own session when not specified
TARGET_SESSION="${TARGET:-${CALLER_SESSION}}"
[ -z "$TARGET_SESSION" ] && error_exit "No target session specified and CREWLY_SESSION_NAME not set. Pass sessionName in input."

# Validate hierarchy: only when targeting a different session (not self)
if [ -n "$TARGET_SESSION" ] && [ "$TARGET_SESSION" != "$CALLER_SESSION" ]; then
  if [ -n "$TEAM_ID" ] && [ -n "$TL_MEMBER_ID" ]; then
    TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
    TEAM_SUCCESS=$(echo "$TEAM_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")

    if [ "$TEAM_SUCCESS" = "true" ]; then
      WORKER_PARENT=$(echo "$TEAM_DATA" | jq -r --arg session "$TARGET_SESSION" \
        '.data.members[] | select(.sessionName == $session) | .parentMemberId // empty' 2>/dev/null || true)

      if [ -z "$WORKER_PARENT" ]; then
        error_exit "Hierarchy violation: target ${TARGET_SESSION} is not a member of team ${TEAM_ID}"
      fi

      if [ "$WORKER_PARENT" != "$TL_MEMBER_ID" ]; then
        error_exit "Hierarchy violation: target ${TARGET_SESSION} (parentMemberId=${WORKER_PARENT}) is not a subordinate of TL ${TL_MEMBER_ID}"
      fi
    fi
  else
    error_exit "teamId and tlMemberId are required when scheduling checks for other sessions"
  fi
fi

# Build API request body
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
