#!/bin/bash
# Query Knowledge Documents - search company knowledge base
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"query\":\"deployment\",\"scope\":\"global\"}'"

QUERY=$(printf '%s' "$INPUT" | jq -r '.query // empty')
SCOPE=$(printf '%s' "$INPUT" | jq -r '.scope // "global"')
CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
require_param "query" "$QUERY"

# URL-encode the query parameters
ENCODED_QUERY=$(printf '%s' "$QUERY" | jq -sRr @uri)
ENDPOINT="/knowledge/documents?scope=${SCOPE}&search=${ENCODED_QUERY}"

if [ -n "$CATEGORY" ]; then
  ENCODED_CATEGORY=$(printf '%s' "$CATEGORY" | jq -sRr @uri)
  ENDPOINT="${ENDPOINT}&category=${ENCODED_CATEGORY}"
fi

if [ -n "$PROJECT_PATH" ]; then
  ENCODED_PATH=$(printf '%s' "$PROJECT_PATH" | jq -sRr @uri)
  ENDPOINT="${ENDPOINT}&projectPath=${ENCODED_PATH}"
fi

api_call GET "$ENDPOINT"
