#!/bin/bash
# Get status of a specific agent by session name
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-session\"}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

# Get all teams and filter for the specific agent
TEAMS=$(api_call GET "/teams")
echo "$TEAMS" | jq --arg name "$SESSION_NAME" '
  .data // . | if type == "array" then . else [.] end |
  [.[].members // [] | .[] | select(.sessionName == $name or .name == $name)] |
  if length == 0 then {"error": "Agent not found", "sessionName": $name}
  elif length == 1 then .[0]
  else .
  end
'
