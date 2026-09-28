#!/bin/bash
# Render a review verdict on a `done_by_worker` WorkItem via the V3 task-pool
# (#819 — replaces the raw-curl instruction in the escalation-router's 2h
# orchestrator message).
#
# Why this skill exists: the escalation message used to tell the orchestrator
# to `curl -X POST .../verdict` directly. A raw curl carries no
# `X-Agent-Session` header, so the backend cannot identify the caller and
# refuses the verdict with `403 not_reviewer` — the orchestrator was being
# told to do something that could never work. `api_call` (config/skills/
# _common/lib.sh) already attaches `X-Agent-Session: $CREWLY_SESSION_NAME` to
# every request, so routing the same POST through it is the fix: run this
# skill with CREWLY_SESSION_NAME set to the orchestrator's own session
# (normally `crewly-orc`) and the backend recognizes it as the orchestrator,
# which the transition gate always allows to render a verdict once an item is
# escalated to it (or when the item has no reviewer of record).
#
# Input shape:
#   { "workItemId": "abc-123", "verdict": "verified"|"rejected", "comment"?: "..." }
#
# Backwards-compat: `taskId` is accepted as an alias for `workItemId`, same
# convention as complete-task/execute.sh.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"abc-123\",\"verdict\":\"verified\",\"comment\":\"...\"}'"

WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // .taskId // empty')
VERDICT=$(printf '%s' "$INPUT" | jq -r '.verdict // empty')
COMMENT=$(printf '%s' "$INPUT" | jq -r '.comment // empty')

require_param "workItemId" "$WORK_ITEM_ID"

if [ "$VERDICT" != "verified" ] && [ "$VERDICT" != "rejected" ]; then
  error_exit "verdict must be \"verified\" or \"rejected\" (got: \"${VERDICT}\")"
fi

if [ -n "$COMMENT" ]; then
  BODY=$(jq -n --arg verdict "$VERDICT" --arg comment "$COMMENT" '{verdict: $verdict, comment: $comment}')
else
  BODY=$(jq -n --arg verdict "$VERDICT" '{verdict: $verdict}')
fi

api_call POST "/task-pool/items/${WORK_ITEM_ID}/verdict" "$BODY"
