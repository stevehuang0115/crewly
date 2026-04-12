#!/bin/bash
# =============================================================================
# release-claim — Release an active claim back to the Task Pool
#
# When an agent finishes a task or cannot continue, it releases its claim
# so the work item can be re-queued or marked as done/failed.
#
# Usage:
#   bash execute.sh '{"workItemId":"wi-abc","reason":"completed"}'
#
# Parameters:
#   workItemId   (required) — The work item ID to release
#   reason       (required) — Why the claim is being released
#                             Use "completed" for finished tasks,
#                             "cannot_complete" for blocked tasks,
#                             "reassign" for hand-off to another agent
#
# Returns:
#   Success: { success: true, released: true }
#   Error:   { success: false, reason: "..." }
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"wi-abc\",\"reason\":\"completed\"}'"

WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // empty')
require_param "workItemId" "$WORK_ITEM_ID"
require_param "reason" "$REASON"

# ---------------------------------------------------------------------------
# Release the work item back to the pool
# ---------------------------------------------------------------------------

BODY=$(jq -n --arg reason "$REASON" '{reason: $reason}')

RESPONSE=$(api_call POST "/task-pool/release/${WORK_ITEM_ID}" "$BODY" 2>&1) || {
  ERROR_MSG=$(printf '%s' "$RESPONSE" | jq -r '.error // .message // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  jq -n --arg reason "$ERROR_MSG" '{success: false, reason: $reason}'
  exit 0
}

SUCCESS=$(printf '%s' "$RESPONSE" | jq -r '.success // false')

if [ "$SUCCESS" = "true" ]; then
  jq -n '{success: true, released: true}'
else
  ERROR=$(printf '%s' "$RESPONSE" | jq -r '.error // .message // "Release failed"')
  jq -n --arg reason "$ERROR" '{success: false, reason: $reason}'
fi
