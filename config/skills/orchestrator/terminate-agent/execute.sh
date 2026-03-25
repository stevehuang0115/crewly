#!/bin/bash
# Terminate an agent's terminal session
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-session\"}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

api_call DELETE "/terminal/${SESSION_NAME}"
