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

# Pre-check the status and explain, rather than letting the state machine
# answer with a bare conflict.
#
# WORK_ITEM_TRANSITIONS (backend/src/types/v2/work-item.types.ts) allows
# `blocked` ONLY from `running` — you can block work you have claimed, not work
# you have merely been dispatched. That rule is deliberate and stays: `blocked`
# has a single outbound edge (-> queued), so every consumer treats it as a
# near-terminal parking state while the state machine does not. Widening the
# ways IN would widen the surface for stranding.
#
# So the fix is the message, not the rule: name the current status and the
# remedy skill, the same disposition as the skipGates rejection.
CURRENT_STATUS=$(api_call GET "/task-pool/items/${WORK_ITEM_ID}" 2>/dev/null \
  | jq -r '(.data // .) | .status // empty' 2>/dev/null || true)

if [ -n "$CURRENT_STATUS" ] && [ "$CURRENT_STATUS" != "running" ]; then
  case "$CURRENT_STATUS" in
    queued|scheduled)
      error_exit "WorkItem ${WORK_ITEM_ID} is '${CURRENT_STATUS}', not 'running' — only a claimed WorkItem can be blocked. Claim it first with the accept-task skill, then block it. If you cannot start it at all, cancel it instead (POST /task-pool/items/${WORK_ITEM_ID}/cancel)." ;;
    blocked)
      error_exit "WorkItem ${WORK_ITEM_ID} is already blocked. To add detail, append a note with the report-progress skill rather than blocking again." ;;
    done|done_by_worker|verified|cancelled|failed|rejected)
      error_exit "WorkItem ${WORK_ITEM_ID} is '${CURRENT_STATUS}' and cannot be blocked — it has already left the running state. If this is wrong, raise it with your team lead rather than forcing a transition." ;;
    *)
      error_exit "WorkItem ${WORK_ITEM_ID} is '${CURRENT_STATUS}', not 'running' — only a claimed (running) WorkItem can be blocked." ;;
  esac
fi

BODY=$(jq -n \
  --arg agentId "$SESSION_NAME" \
  --arg reason "$REASON" \
  '{agentId: $agentId, reason: $reason}')

api_call POST "/task-pool/block/${WORK_ITEM_ID}" "$BODY"
