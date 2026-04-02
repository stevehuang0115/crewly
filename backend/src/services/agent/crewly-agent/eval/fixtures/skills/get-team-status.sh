#!/bin/bash
# Eval skill shim: get-team-status
#
# Reads team configuration and returns current member statuses.
# Reads from .crewly/teams/team-config.json in the work directory.
#
# Usage:
#   bash skills/get-team-status.sh '{}'
#
# Output: JSON with team members and their statuses

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_log.sh"

INPUT="${1:-'{}'}"
log_tool_call "get-team-status" "$INPUT"

CONFIG_FILE=".crewly/teams/team-config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo '{"success":false,"error":"Team config not found at '"$CONFIG_FILE"'"}'
  exit 1
fi

# Read and return team config with success wrapper
TEAM_DATA=$(cat "$CONFIG_FILE" 2>/dev/null)
if ! echo "$TEAM_DATA" | jq empty 2>/dev/null; then
  echo '{"success":false,"error":"Team config is not valid JSON"}'
  exit 1
fi

echo "$TEAM_DATA" | jq '{success: true, data: .}'
