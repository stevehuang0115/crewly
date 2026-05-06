#!/bin/bash
# Mark a WorkItem as blocked with a reason.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. The
# legacy `/task-management/block` endpoint (which moved a `.md` file to
# `delegated/blocked/`) is no longer the source of truth — V3 task-pool's
# `/task-pool/block/:workItemId` is.
#
# Input shape:
#   { "workItemId": "abc-123", "reason": "missing creds", "questions"?: "...", "urgency"?: "..." }
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

BODY=$(jq -n \
  --arg reason "$REASON" \
  --arg questions "$QUESTIONS" \
  --arg urgency "$URGENCY" \
  '{reason: $reason} +
   (if $questions != "" then {questions: $questions} else {} end) +
   (if $urgency != "" then {urgency: $urgency} else {} end)')

api_call POST "/task-pool/block/${WORK_ITEM_ID}" "$BODY"
