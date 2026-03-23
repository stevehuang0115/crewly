#!/bin/bash
# Get status of a specific agent by session name
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-session\"}'"

SESSION_NAME=$(echo "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

# Get all teams and filter for the specific agent.
# Retry once after 2s if not found (#280: registration race condition).
for attempt in 1 2; do
  TEAMS=$(api_call GET "/teams")
  RESULT=$(echo "$TEAMS" | jq --arg name "$SESSION_NAME" '
    .data // . | if type == "array" then . else [.] end |
    [.[].members // [] | .[] | select(.sessionName == $name or .name == $name)] |
    if length == 0 then {"error": "Agent not found", "sessionName": $name}
    elif length == 1 then .[0]
    else .
    end
  ')

  # If found, output and exit
  NOT_FOUND=$(echo "$RESULT" | jq -r '.error // empty')
  if [ -z "$NOT_FOUND" ]; then
    echo "$RESULT"
    exit 0
  fi

  # Retry after brief delay (registration may still be flushing to storage)
  if [ "$attempt" -eq 1 ]; then
    sleep 2
  fi
done

# Return the not-found result after retries
echo "$RESULT"
