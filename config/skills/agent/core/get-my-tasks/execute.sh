#!/bin/bash
# Retrieve all tasks assigned to this agent session
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"...\",\"projectPath\":\"...\"}' or echo '{...}' | execute.sh"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
require_param "sessionName" "$SESSION_NAME"
require_param "projectPath" "$PROJECT_PATH"

# URL-encode the session name and project path for query parameters
ENCODED_SESSION=$(printf '%s' "$SESSION_NAME" | jq -sRr @uri)
ENCODED_PROJECT=$(printf '%s' "$PROJECT_PATH" | jq -sRr @uri)

api_call GET "/task-management/tasks?sessionName=${ENCODED_SESSION}&projectPath=${ENCODED_PROJECT}"
