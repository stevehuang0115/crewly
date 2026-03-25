#!/bin/bash
# Report progress on the current task
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"dev-1\",\"progress\":50,\"current\":\"Implementing tests\"}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
PROGRESS=$(printf '%s' "$INPUT" | jq -r '.progress // empty')
CURRENT=$(printf '%s' "$INPUT" | jq -r '.current // empty')
require_param "sessionName" "$SESSION_NAME"
require_param "progress" "$PROGRESS"
require_param "current" "$CURRENT"

# Build body with required and optional fields
BODY=$(printf '%s' "$INPUT" | jq '{
  sessionName: .sessionName,
  progress: (.progress | tonumber),
  current: .current
} +
  (if .completed then {completed: .completed} else {} end) +
  (if .nextSteps then {nextSteps: .nextSteps} else {} end) +
  (if .blockers then {blockers: .blockers} else {} end) +
  (if .ticketId then {ticketId: .ticketId} else {} end)')

api_call POST "/task-management/sync" "$BODY"
