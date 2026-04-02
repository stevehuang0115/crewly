#!/bin/bash
# Eval skill shim: handle-failure
#
# Decision engine for failure recovery: retry, reassign, or escalate.
# Reads team config to find alternative workers when reassigning.
#
# Usage:
#   bash skills/handle-failure.sh '{"worker":"eval-dev-max","error":"agent went inactive","action":"reassign"}'
#
# Output: JSON with decided action and target worker

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_log.sh"

INPUT="${1:-'{}'}"
log_tool_call "handle-failure" "$INPUT"

WORKER=$(echo "$INPUT" | jq -r '.worker // "unknown"')
ERROR=$(echo "$INPUT" | jq -r '.error // "unknown error"')
ACTION=$(echo "$INPUT" | jq -r '.action // "escalate"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# If action is reassign, find an active alternative
REASSIGN_TO=""
if [ "$ACTION" = "reassign" ]; then
  CONFIG_FILE=".crewly/teams/team-config.json"
  if [ -f "$CONFIG_FILE" ]; then
    # Find first active developer that isn't the failed worker
    # Excludes team-lead role to prefer developer workers
    REASSIGN_TO=$(jq -r \
      --arg failed "$WORKER" \
      '.members[] | select(.agentStatus == "active" and .sessionName != $failed and .role != "team-lead") | .sessionName' \
      "$CONFIG_FILE" 2>/dev/null | head -1)
    # Fallback: if no active developer, accept any active member
    if [ -z "$REASSIGN_TO" ]; then
      REASSIGN_TO=$(jq -r \
        --arg failed "$WORKER" \
        '.members[] | select(.agentStatus == "active" and .sessionName != $failed) | .sessionName' \
        "$CONFIG_FILE" 2>/dev/null | head -1)
    fi
  fi

  if [ -z "$REASSIGN_TO" ]; then
    ACTION="escalate"
    ERROR="$ERROR; no active worker available for reassignment"
  fi
fi

# Write failure record
mkdir -p .crewly/reports
FAILURE_ID="failure-$(date +%s)-$$"

cat > ".crewly/reports/${FAILURE_ID}.json" <<EOF
{
  "failureId": "$FAILURE_ID",
  "failedWorker": "$WORKER",
  "error": $(echo "$ERROR" | jq -Rs .),
  "action": "$ACTION",
  "reassignTo": "$REASSIGN_TO",
  "decidedAt": "$TIMESTAMP"
}
EOF

jq -n \
  --arg action "$ACTION" \
  --arg worker "$REASSIGN_TO" \
  --arg failureId "$FAILURE_ID" \
  '{success: true, action: $action, reassignTo: $worker, failureId: $failureId}'
