#!/bin/bash
# =============================================================================
# extend-lease — Extend the lease on an active Task Pool claim
#
# When an agent needs more time to complete a task (approaching the 10-minute
# lease expiry), it calls this skill to extend the lease. Each claim allows
# up to 3 extensions (configurable server-side).
#
# Usage:
#   bash execute.sh '{"claimId":"claim-abc","sessionName":"agent-1"}'
#
# Parameters:
#   claimId      (required) — The active claim ID to extend
#   sessionName  (required) — Agent session name (must match claim owner)
#
# Returns:
#   Success: { success: true, claim: {...}, extensionsRemaining: N }
#   Error:   { success: false, reason: "..." }
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"claimId\":\"claim-abc\",\"sessionName\":\"agent-1\"}'"

CLAIM_ID=$(printf '%s' "$INPUT" | jq -r '.claimId // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "claimId" "$CLAIM_ID"
require_param "sessionName" "$SESSION_NAME"

# ---------------------------------------------------------------------------
# Request lease extension from Task Pool API
# ---------------------------------------------------------------------------

BODY=$(jq -n \
  --arg claimId "$CLAIM_ID" \
  --arg agentId "$SESSION_NAME" \
  '{claimId: $claimId, agentId: $agentId}')

RESPONSE=$(api_call POST "/task-pool/extend-lease" "$BODY" 2>&1) || {
  ERROR_MSG=$(printf '%s' "$RESPONSE" | jq -r '.error // .message // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  jq -n --arg reason "$ERROR_MSG" '{success: false, reason: $reason}'
  exit 0
}

SUCCESS=$(printf '%s' "$RESPONSE" | jq -r '.success // false')
CLAIM_OBJ=$(printf '%s' "$RESPONSE" | jq -c '.data.claim // .data // null')

if [ "$SUCCESS" = "true" ]; then
  # Calculate remaining extensions
  EXT_COUNT=$(printf '%s' "$CLAIM_OBJ" | jq -r '.extensionCount // 0')
  MAX_EXT=$(printf '%s' "$CLAIM_OBJ" | jq -r '.maxExtensions // 3')
  REMAINING=$((MAX_EXT - EXT_COUNT))

  jq -n \
    --argjson claim "$CLAIM_OBJ" \
    --argjson remaining "$REMAINING" \
    '{success: true, claim: $claim, extensionsRemaining: $remaining}'
else
  REASON=$(printf '%s' "$RESPONSE" | jq -r '.error // .message // "Extension rejected"')
  jq -n --arg reason "$REASON" '{success: false, reason: $reason}'
fi
