#!/bin/bash
# Accept and take the next available task from the task queue
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"dev-1\"}' or echo '{...}' | execute.sh"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

TEAM_MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.teamMemberId // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
TASK_GROUP=$(printf '%s' "$INPUT" | jq -r '.taskGroup // empty')

BODY=$(jq -n \
  --arg sessionName "$SESSION_NAME" \
  --arg teamMemberId "$TEAM_MEMBER_ID" \
  --arg projectPath "$PROJECT_PATH" \
  --arg taskGroup "$TASK_GROUP" \
  '{sessionName: $sessionName} +
   (if $teamMemberId != "" then {teamMemberId: $teamMemberId} else {} end) +
   (if $projectPath != "" then {projectPath: $projectPath} else {} end) +
   (if $taskGroup != "" then {taskGroup: $taskGroup} else {} end)')

api_call POST "/task-management/take-next" "$BODY"
