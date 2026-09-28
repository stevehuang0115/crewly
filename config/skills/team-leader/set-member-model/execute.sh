#!/bin/bash
# Set the model a subordinate member runs on (opus | sonnet | default).
# Only run this after the owner explicitly agreed to the change.
# Validates hierarchy (member.parentMemberId == TL.memberId) before PATCHing
# the member's modelId. The new model takes effect on the member's next start.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"team-uuid\",\"memberId\":\"member-uuid\",\"tlMemberId\":\"tl-member-id\",\"model\":\"opus|sonnet|default\"}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.memberId // empty')
TL_MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.tlMemberId // empty')
MODEL=$(printf '%s' "$INPUT" | jq -r '.model // empty' | tr '[:upper:]' '[:lower:]')
require_param "teamId" "$TEAM_ID"
require_param "memberId" "$MEMBER_ID"
require_param "tlMemberId" "$TL_MEMBER_ID"
require_param "model" "$MODEL"

# `default` clears the per-member override: the member falls back to the
# team default (Sonnet for members with a lead above them, Opus for leads).
case "$MODEL" in
  opus)    MODEL_ID="opus" ;;
  sonnet)  MODEL_ID="sonnet" ;;
  default) MODEL_ID="" ;;
  *) error_exit "Invalid model '${MODEL}': use opus, sonnet or default" ;;
esac

TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
TEAM_SUCCESS=$(echo "$TEAM_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")
if [ "$TEAM_SUCCESS" != "true" ]; then
  error_exit "Failed to fetch team data for team ${TEAM_ID}"
fi

MEMBER_PARENT=$(echo "$TEAM_DATA" | jq -r --arg mid "$MEMBER_ID" \
  '.data.members[] | select(.id == $mid) | .parentMemberId // empty' 2>/dev/null || true)
if [ -z "$MEMBER_PARENT" ]; then
  error_exit "Member ${MEMBER_ID} not found in team ${TEAM_ID} or has no parentMemberId set"
fi
if [ "$MEMBER_PARENT" != "$TL_MEMBER_ID" ]; then
  error_exit "Hierarchy violation: member ${MEMBER_ID} (parentMemberId=${MEMBER_PARENT}) is not a subordinate of TL ${TL_MEMBER_ID}"
fi

BODY=$(jq -n --arg modelId "$MODEL_ID" '{modelId: $modelId}')
RESULT=$(api_call PATCH "/teams/${TEAM_ID}/members/${MEMBER_ID}" "$BODY")

jq -n \
  --arg memberId "$MEMBER_ID" \
  --arg model "$MODEL" \
  --arg modelId "$MODEL_ID" \
  --argjson result "$(printf '%s' "$RESULT" | jq -c . 2>/dev/null || echo '{}')" \
  '{success: ($result.success // true), memberId: $memberId, model: $model, modelId: (if $modelId == "" then null else $modelId end),
    note: "Takes effect the next time this member starts (stop-agent + start-agent to apply now, when it is idle)."}'
