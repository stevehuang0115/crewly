#!/bin/bash
# Mark a WorkItem as blocked with a reason.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. The
# legacy `/task-management/block` endpoint (which moved a `.md` file to
# `delegated/blocked/`) is no longer the source of truth — V3 task-pool's
# `/task-pool/block/:workItemId` is.
#
# Input shape:
#   { "workItemId": "abc-123", "sessionName": "dev-1", "reason": "missing creds",
#     "questions"?: "...", "urgency"?: "..." }
#
# `sessionName` is REQUIRED (sent as `agentId`) — the endpoint 400s without it.
# `questions`/`urgency` are folded into `reason`; the endpoint has no field for
# them.
#
# Backwards-compat: if `absoluteTaskPath` is provided instead of
# `workItemId`, we emit a warning and skip the call rather than fall back
# to the deprecated v1 path. Callers should obtain `workItemId` from the
# claim response or from a [CREWLY-DISPATCH] terminal message.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"abc-123\",\"reason\":\"Missing API credentials\"}'"

WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // empty')
QUESTIONS=$(printf '%s' "$INPUT" | jq -r '.questions // empty')
URGENCY=$(printf '%s' "$INPUT" | jq -r '.urgency // empty')
LEGACY_PATH=$(printf '%s' "$INPUT" | jq -r '.absoluteTaskPath // empty')

if [ -z "$WORK_ITEM_ID" ] && [ -n "$LEGACY_PATH" ]; then
  echo '{"error":"`absoluteTaskPath` is no longer accepted — pass `workItemId` instead. See spec/2026-05-06-task-management-v1-deprecation.md"}' >&2
  exit 1
fi

require_param "workItemId" "$WORK_ITEM_ID"
require_param "reason" "$REASON"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // .agentId // empty')
[ -z "$SESSION_NAME" ] && SESSION_NAME="${CREWLY_SESSION_NAME:-}"
require_param "sessionName (or agentId, or CREWLY_SESSION_NAME)" "$SESSION_NAME"

# `blockItem` destructures ONLY `{agentId, reason}` and hard-requires agentId
# (400 "agentId is required"). This skill previously sent neither agentId nor a
# readable home for `questions`/`urgency`, so EVERY call 400'd — the skill
# agents use to report being blocked could not report anything.
#
# `questions` and `urgency` have no field on this endpoint. Rather than drop
# caller-supplied content on the floor (the same silent-discard bug in a new
# shape), they are folded into `reason`, which IS read and is forwarded to
# TaskProjection.markBlocked. The information survives; only the structure is
# lost, and the endpoint has nowhere to put the structure.
if [ -n "$URGENCY" ]; then
  REASON="[urgency: ${URGENCY}] ${REASON}"
fi
if [ -n "$QUESTIONS" ]; then
  REASON="${REASON}

Open questions: ${QUESTIONS}"
fi

BODY=$(jq -n \
  --arg agentId "$SESSION_NAME" \
  --arg reason "$REASON" \
  '{agentId: $agentId, reason: $reason}')

api_call POST "/task-pool/block/${WORK_ITEM_ID}" "$BODY"
