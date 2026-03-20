#!/bin/bash
# Send a direct message to another agent's terminal session
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"to\":\"agent-session\",\"message\":\"Can you review my PR?\"}'"

# Accept both "to" and "sessionName" for compatibility (#231)
TO=$(echo "$INPUT" | jq -r '.to // .sessionName // empty')
MESSAGE=$(echo "$INPUT" | jq -r '.message // empty')
require_param "to (or sessionName)" "$TO"
require_param "message" "$MESSAGE"

BODY=$(jq -n --arg data "$MESSAGE" --arg mode "message" '{data: $data, mode: $mode}')

api_call POST "/terminal/${TO}/write" "$BODY"
