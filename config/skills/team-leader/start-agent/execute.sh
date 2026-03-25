#!/bin/bash
# Start a worker agent within this Team Leader's subordinate scope.
# Validates hierarchy (worker.parentMemberId == TL.memberId) before starting.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"team-uuid\",\"memberId\":\"member-uuid\",\"tlMemberId\":\"tl-member-id\"}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.memberId // empty')
TL_MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.tlMemberId // empty')
require_param "teamId" "$TEAM_ID"
require_param "memberId" "$MEMBER_ID"
require_param "tlMemberId" "$TL_MEMBER_ID"

# Validate hierarchy: target worker must be a subordinate of this TL
TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
TEAM_SUCCESS=$(echo "$TEAM_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")

if [ "$TEAM_SUCCESS" != "true" ]; then
  error_exit "Failed to fetch team data for team ${TEAM_ID}"
fi

# Find the target member and check parentMemberId
WORKER_PARENT=$(echo "$TEAM_DATA" | jq -r --arg mid "$MEMBER_ID" \
  '.data.members[] | select(.id == $mid) | .parentMemberId // empty' 2>/dev/null || true)

if [ -z "$WORKER_PARENT" ]; then
  error_exit "Member ${MEMBER_ID} not found in team ${TEAM_ID} or has no parentMemberId set"
fi

if [ "$WORKER_PARENT" != "$TL_MEMBER_ID" ]; then
  error_exit "Hierarchy violation: member ${MEMBER_ID} (parentMemberId=${WORKER_PARENT}) is not a subordinate of TL ${TL_MEMBER_ID}"
fi

# Hierarchy validated — start the agent
api_call POST "/teams/${TEAM_ID}/members/${MEMBER_ID}/start"
