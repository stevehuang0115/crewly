#!/bin/bash
# Mark a task as blocked with a reason and optional questions
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"absoluteTaskPath\":\"/path/to/task\",\"reason\":\"Missing API credentials\"}'"

ABSOLUTE_TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.absoluteTaskPath // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // empty')
QUESTIONS=$(printf '%s' "$INPUT" | jq -r '.questions // empty')
URGENCY=$(printf '%s' "$INPUT" | jq -r '.urgency // empty')
require_param "absoluteTaskPath" "$ABSOLUTE_TASK_PATH"
require_param "reason" "$REASON"

BODY=$(jq -n \
  --arg absoluteTaskPath "$ABSOLUTE_TASK_PATH" \
  --arg reason "$REASON" \
  --arg questions "$QUESTIONS" \
  --arg urgency "$URGENCY" \
  '{absoluteTaskPath: $absoluteTaskPath, reason: $reason} +
   (if $questions != "" then {questions: $questions} else {} end) +
   (if $urgency != "" then {urgency: $urgency} else {} end)')

api_call POST "/task-management/block" "$BODY"
