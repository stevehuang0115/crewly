#!/bin/bash
# Set a project goal
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"goal\":\"...\",\"projectPath\":\"...\",\"setBy\":\"orchestrator\"}'"

GOAL=$(printf '%s' "$INPUT" | jq -r '.goal // empty')
require_param "goal" "$GOAL"

api_call POST "/memory/goals" "$INPUT"
