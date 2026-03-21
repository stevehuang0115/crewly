#!/bin/bash
# Register an agent with the Crewly backend
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"role\":\"developer\",\"sessionName\":\"dev-1\"}'"

# Accept both canonical (role/sessionName) and legacy (agentRole/agentId) parameter names
ROLE=$(echo "$INPUT" | jq -r '.role // .agentRole // empty')
SESSION_NAME=$(echo "$INPUT" | jq -r '.sessionName // .agentId // empty')
require_param "role" "$ROLE"
require_param "sessionName" "$SESSION_NAME"

# Optional: claudeSessionId for resume support
CLAUDE_SESSION_ID=$(echo "$INPUT" | jq -r '.claudeSessionId // empty')
TEAM_MEMBER_ID=$(echo "$INPUT" | jq -r '.teamMemberId // empty')

BODY=$(jq -n \
  --arg role "$ROLE" \
  --arg sessionName "$SESSION_NAME" \
  --arg claudeSessionId "$CLAUDE_SESSION_ID" \
  --arg teamMemberId "$TEAM_MEMBER_ID" \
  '{role: $role, sessionName: $sessionName} +
   (if $claudeSessionId != "" then {claudeSessionId: $claudeSessionId} else {} end) +
   (if $teamMemberId != "" then {teamMemberId: $teamMemberId} else {} end)')

api_call POST "/teams/members/register" "$BODY"
