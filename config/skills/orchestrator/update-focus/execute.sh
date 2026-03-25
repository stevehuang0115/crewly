#!/bin/bash
# Update the team's current focus
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"focus\":\"...\",\"projectPath\":\"...\",\"updatedBy\":\"orchestrator\"}'"

FOCUS=$(printf '%s' "$INPUT" | jq -r '.focus // empty')
require_param "focus" "$FOCUS"

api_call POST "/memory/focus" "$INPUT"
