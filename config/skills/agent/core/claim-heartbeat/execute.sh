#!/bin/bash
# =============================================================================
# claim-heartbeat — Send heartbeat for an active Task Pool claim
#
# Agents call this every 2 minutes while working on a claimed task.
# The heartbeat proves liveness to the Reconciler and prevents the claim
# from being revoked due to lease expiry.
#
# Usage:
#   bash execute.sh '{"claimId":"claim-abc","sessionName":"agent-1"}'
#
# Parameters:
#   claimId      (required) — The active claim ID to heartbeat
#   sessionName  (required) — Agent session name (must match claim owner)
#
# Returns:
#   Success: { success: true, claim: {...} }
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
# Send heartbeat to Task Pool API
# ---------------------------------------------------------------------------

BODY=$(jq -n \
  --arg claimId "$CLAIM_ID" \
  --arg agentId "$SESSION_NAME" \
  '{claimId: $claimId, agentId: $agentId}')

RESPONSE=$(api_call POST "/task-pool/heartbeat" "$BODY" 2>&1) || {
  # Parse error response
  ERROR_MSG=$(printf '%s' "$RESPONSE" | jq -r '.error // .message // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  jq -n --arg reason "$ERROR_MSG" '{success: false, reason: $reason}'
  exit 0
}

# Extract result
SUCCESS=$(printf '%s' "$RESPONSE" | jq -r '.success // false')
CLAIM_OBJ=$(printf '%s' "$RESPONSE" | jq -c '.data.claim // .data // null')

if [ "$SUCCESS" = "true" ]; then
  jq -n --argjson claim "$CLAIM_OBJ" '{success: true, claim: $claim}'
else
  REASON=$(printf '%s' "$RESPONSE" | jq -r '.error // .message // "Heartbeat rejected"')
  jq -n --arg reason "$REASON" '{success: false, reason: $reason}'
fi
