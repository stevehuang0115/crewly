#!/bin/bash
# Record a successful pattern or approach
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"description\":\"...\",\"projectPath\":\"...\",\"teamMemberId\":\"...\",\"context\":\"...\"}'"

DESCRIPTION=$(printf '%s' "$INPUT" | jq -r '.description // empty')
require_param "description" "$DESCRIPTION"

api_call POST "/memory/record-success" "$INPUT"
