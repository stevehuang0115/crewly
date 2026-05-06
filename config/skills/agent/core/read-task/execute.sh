#!/bin/bash
# Fetch a single WorkItem by id from the V3 task-pool.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# `POST /task-management/read-task`, which read the `.md` file body from
# the project's `.crewly/tasks/` filesystem. With v1 retired, the full
# task body, brief, and worker output live on the WorkItem itself.
#
# Input: { "workItemId": "abc-123" }
# Backwards-compat shim: if `absoluteTaskPath` is supplied instead, refuse
# with a hard error directing callers to pass `workItemId`.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"abc-123\"}'"

WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // empty')
LEGACY_PATH=$(printf '%s' "$INPUT" | jq -r '.absoluteTaskPath // empty')

if [ -z "$WORK_ITEM_ID" ] && [ -n "$LEGACY_PATH" ]; then
  echo '{"error":"`absoluteTaskPath` is no longer accepted — pass `workItemId`. See spec/2026-05-06-task-management-v1-deprecation.md"}' >&2
  exit 1
fi

require_param "workItemId" "$WORK_ITEM_ID"

api_call GET "/task-pool/items/${WORK_ITEM_ID}"
