#!/bin/bash
# Retrieve all tasks assigned to this agent session
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"crewly-product-sam-xxxx\"}'"

SESSION_NAME=$(echo "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

# URL-encode the session name for query parameter
ENCODED_SESSION=$(printf '%s' "$SESSION_NAME" | jq -sRr @uri)

api_call GET "/task-management/tasks?sessionName=${ENCODED_SESSION}"
