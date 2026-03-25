#!/bin/bash
# Store knowledge in agent memory for future reference
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"content\":\"...\",\"category\":\"pattern\",\"scope\":\"agent\",\"teamMemberId\":\"...\",\"projectPath\":\"...\"}'"

CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // empty')
require_param "content" "$CONTENT"
require_param "category" "$CATEGORY"

api_call POST "/memory/remember" "$INPUT"
