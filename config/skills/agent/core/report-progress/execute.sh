#!/bin/bash
# Append a progress note to the agent's currently-claimed WorkItem.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# `POST /task-management/sync`, which appended progress lines to the `.md`
# task body. Notes now accumulate under `WorkItem.metadata.notes[]`.
#
# Input shape:
#   { "sessionName": "dev-1", "progress": 50, "current": "Implementing tests",
#     "workItemId"?: "abc-123",  // optional override
#     "completed"?: ["t1"], "nextSteps"?: ["t2"], "blockers"?: ["..."] }
#
# If `workItemId` is omitted, the agent's currently-running claim is
# resolved from the pool.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"dev-1\",\"progress\":50,\"current\":\"Implementing tests\"}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
PROGRESS=$(printf '%s' "$INPUT" | jq -r '.progress // empty')
CURRENT=$(printf '%s' "$INPUT" | jq -r '.current // empty')
WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // empty')
require_param "sessionName" "$SESSION_NAME"
require_param "progress" "$PROGRESS"
require_param "current" "$CURRENT"

# Resolve target WI: explicit > running claim for this agent
if [ -z "$WORK_ITEM_ID" ]; then
  POOL_RESP=$(api_call GET "/task-pool/items?status=running&target=${SESSION_NAME}" 2>/dev/null || echo '{}')
  WORK_ITEM_ID=$(echo "$POOL_RESP" | jq -r '.workItems[0].id // .data[0].id // empty' 2>/dev/null || true)
fi

if [ -z "$WORK_ITEM_ID" ]; then
  echo '{"warning":"no active WorkItem for session — progress note discarded"}' >&2
  exit 0
fi

# Compose a single multi-line note from the structured fields
NOTE=$(printf '%s' "$INPUT" | jq -r '
  ([
    "Progress: \(.progress)% — \(.current)",
    (if (.completed // [] | length) > 0 then "Completed: \(.completed | join(", "))" else empty end),
    (if (.nextSteps // [] | length) > 0 then "Next: \(.nextSteps | join(", "))" else empty end),
    (if (.blockers // [] | length) > 0 then "Blockers: \(.blockers | join(", "))" else empty end)
  ] | join("\n"))')

BODY=$(jq -n --arg author "$SESSION_NAME" --arg note "$NOTE" '{author: $author, note: $note}')

api_call POST "/task-pool/items/${WORK_ITEM_ID}/notes" "$BODY"
