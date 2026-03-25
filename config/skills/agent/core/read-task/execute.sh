#!/bin/bash
# Read the full details of a task file by its absolute path
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"absoluteTaskPath\":\"/path/to/task\"}'"

ABSOLUTE_TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.absoluteTaskPath // empty')
require_param "absoluteTaskPath" "$ABSOLUTE_TASK_PATH"

BODY=$(jq -n --arg absoluteTaskPath "$ABSOLUTE_TASK_PATH" '{absoluteTaskPath: $absoluteTaskPath}')

api_call POST "/task-management/read-task" "$BODY"
