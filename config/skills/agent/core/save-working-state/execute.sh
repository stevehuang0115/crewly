#!/bin/bash
# Save free-form working state for the current task — persists across session restarts.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# `POST /task-management/save-working-notes`, which wrote a separate
# `.md` notes file. Notes now accumulate under `WorkItem.metadata.notes[]`.
#
# Input shape:
#   { "workItemId": "abc-123", "sessionName": "dev-1", "notes": "current state..." }
#
# Backwards-compat: a `taskId` field is accepted as an alias for
# `workItemId` for one release window. New callers should use `workItemId`.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"abc-123\",\"sessionName\":\"dev-1\",\"notes\":\"current state\"}'"

WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // .taskId // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
NOTES=$(printf '%s' "$INPUT" | jq -r '.notes // empty')
require_param "workItemId" "$WORK_ITEM_ID"
require_param "sessionName" "$SESSION_NAME"
require_param "notes" "$NOTES"

BODY=$(jq -n --arg author "$SESSION_NAME" --arg note "$NOTES" '{author: $author, note: $note}')

api_call POST "/task-pool/items/${WORK_ITEM_ID}/notes" "$BODY"
