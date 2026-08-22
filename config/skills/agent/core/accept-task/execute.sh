#!/bin/bash
# Claim a WorkItem from the V3 task-pool.
#
# Two modes, mirroring `POST /api/task-pool/claim`:
#
#   1. Next-available (FIFO) — omit `workItemId`. The pool picks the
#      highest-scored queued item available to this agent.
#   2. Targeted — pass `workItemId` (or its alias `taskId`). Claims THAT
#      specific item. The controller branches to `claimSpecificItem`, which
#      still enforces the agent-liveness and target-respect gates.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. The
# legacy `/task-management/take-next` endpoint (which read `.md` files
# from `delegated/open/`) is no longer the source of truth.
#
# Input shape (backwards-compat from v1):
#   { "sessionName": "dev-1", "workItemId"?: "wi-abc", "projectPath"?: "...", "taskGroup"?: "..." }
#
# `taskGroup` (legacy v1 milestone filter) maps to V3's `filters.types`.
# `teamMemberId` is no longer needed — V3 keys claims by `agentId`
# (= sessionName).
#
# A targeted claim that cannot be satisfied surfaces the endpoint's 404 and
# exits non-zero. It deliberately does NOT fall back to next-available:
# silently handing back a DIFFERENT WorkItem than the one requested misroutes
# delegated work, which is strictly worse than a visible failure. (Quinn
# 2026-08-21: this skill dropped `workItemId` entirely, so every targeted
# delegation silently claimed an unrelated FIFO item instead.)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"dev-1\"}' or execute.sh '{\"sessionName\":\"dev-1\",\"workItemId\":\"wi-abc\"}' or echo '{...}' | execute.sh"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

# Accept `workItemId` or the `taskId` alias — briefs and dispatch messages
# refer to the item by id under both names.
WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // .taskId // empty')

# v1's `taskGroup` is informational metadata; V3 filters by WorkItem `type`
# instead. We pass the session name as the agent identity and let the pool
# pick the highest-scored available WI for this agent — unless a specific
# item was requested, in which case the pool must honour that id or fail.
if [ -n "$WORK_ITEM_ID" ]; then
  BODY=$(jq -n --arg agentId "$SESSION_NAME" --arg workItemId "$WORK_ITEM_ID" \
    '{agentId: $agentId, workItemId: $workItemId}')
else
  BODY=$(jq -n --arg agentId "$SESSION_NAME" '{agentId: $agentId}')
fi

api_call POST "/task-pool/claim" "$BODY"
