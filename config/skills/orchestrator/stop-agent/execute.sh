#!/bin/bash
# Stop a specific agent within a team
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"team-uuid\",\"memberId\":\"member-uuid\"}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.memberId // empty')
require_param "teamId" "$TEAM_ID"
require_param "memberId" "$MEMBER_ID"

api_call POST "/teams/${TEAM_ID}/members/${MEMBER_ID}/stop"
