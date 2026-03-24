#!/bin/bash
# Save working state for current task — persists across session restarts
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"taskId\":\"xxx\",\"sessionName\":\"crewly-product-sam-xxx\",\"notes\":\"current state...\"}'"

TASK_ID=$(echo "$INPUT" | jq -r '.taskId // empty')
SESSION_NAME=$(echo "$INPUT" | jq -r '.sessionName // empty')
NOTES=$(echo "$INPUT" | jq -r '.notes // empty')
require_param "taskId" "$TASK_ID"
require_param "sessionName" "$SESSION_NAME"
require_param "notes" "$NOTES"

BODY=$(echo "$INPUT" | jq '{taskId: .taskId, sessionName: .sessionName, notes: .notes}')

api_call POST "/task-management/save-working-notes" "$BODY"
