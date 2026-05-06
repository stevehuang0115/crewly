#!/bin/bash
# Assign / reassign a WorkItem's target agent via the V3 task-pool.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# `POST /task-management/assign`, which moved a `.md` file between agent
# task directories. Now a single `target` field flip on the WorkItem.
#
# Input shape:
#   { "workItemId": "abc-123", "target": "agent-session", "reason"?: "..." }
#
# Backwards-compat: `taskId` accepted as alias for `workItemId`,
# `assignee` accepted as alias for `target`.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"abc-123\",\"target\":\"agent-session\"}'"

WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // .taskId // empty')
NEW_TARGET=$(printf '%s' "$INPUT" | jq -r '.target // .assignee // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // "Assigned via orchestrator"')
FROM_AGENT=$(printf '%s' "$INPUT" | jq -r '.from // .fromAgent // "orchestrator"')

require_param "workItemId" "$WORK_ITEM_ID"
require_param "target" "$NEW_TARGET"

BODY=$(jq -n \
  --arg newTarget "$NEW_TARGET" \
  --arg fromAgent "$FROM_AGENT" \
  --arg reason "$REASON" \
  '{newTarget: $newTarget, fromAgent: $fromAgent, reason: $reason}')

api_call POST "/task-pool/items/${WORK_ITEM_ID}/handoff" "$BODY"
