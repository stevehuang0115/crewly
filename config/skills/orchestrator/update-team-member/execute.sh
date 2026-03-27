#!/bin/bash
# Update a team member's properties (name, role, runtimeType, systemPrompt, etc.)
# If only runtimeType is being updated, uses the dedicated runtime endpoint for validation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit 'Usage: execute.sh '"'"'{"teamId":"uuid","memberId":"uuid","runtimeType":"claude-code"}'"'"''

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.memberId // empty')
require_param "teamId" "$TEAM_ID"
require_param "memberId" "$MEMBER_ID"

# Remove teamId and memberId from the body (they go in the URL)
BODY=$(printf '%s' "$INPUT" | jq 'del(.teamId, .memberId)')

# Check if this is a runtime-only update (use the dedicated endpoint for validation)
KEYS=$(printf '%s' "$BODY" | jq -r 'keys[]')
if [ "$KEYS" = "runtimeType" ]; then
  api_call PUT "/teams/$TEAM_ID/members/$MEMBER_ID/runtime" "$BODY"
else
  api_call PUT "/teams/$TEAM_ID/members/$MEMBER_ID" "$BODY"
fi
