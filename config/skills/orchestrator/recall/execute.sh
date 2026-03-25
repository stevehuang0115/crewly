#!/bin/bash
# Retrieve relevant knowledge from agent memory
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"context\":\"deployment process\",\"scope\":\"both\",\"teamMemberId\":\"...\"}'"

CONTEXT=$(printf '%s' "$INPUT" | jq -r '.context // empty')
require_param "context" "$CONTEXT"

api_call POST "/memory/recall" "$INPUT"
