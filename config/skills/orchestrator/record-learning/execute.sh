#!/bin/bash
# Quickly record a learning or discovery
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"learning\":\"Always check agent status before delegating\",\"teamMemberId\":\"...\"}'"

LEARNING=$(printf '%s' "$INPUT" | jq -r '.learning // empty')
require_param "learning" "$LEARNING"

api_call POST "/memory/record-learning" "$INPUT"
