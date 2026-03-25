#!/bin/bash
# Query standard operating procedures relevant to the current context
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"context\":\"deploying to production\"}'"

CONTEXT=$(printf '%s' "$INPUT" | jq -r '.context // empty')
require_param "context" "$CONTEXT"

CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // empty')
ROLE=$(printf '%s' "$INPUT" | jq -r '.role // empty')

BODY=$(jq -n \
  --arg context "$CONTEXT" \
  --arg category "$CATEGORY" \
  --arg role "$ROLE" \
  '{context: $context} +
   (if $category != "" then {category: $category} else {} end) +
   (if $role != "" then {role: $role} else {} end)')

api_call POST "/system/sops/query" "$BODY"
