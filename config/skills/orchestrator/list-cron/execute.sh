#!/bin/bash
# List all cron tasks
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
QUERY=""

if [ -n "$INPUT" ]; then
  TARGET=$(printf '%s' "$INPUT" | jq -r '.targetAgent // empty')
  ENABLED=$(printf '%s' "$INPUT" | jq -r '.enabled // empty')
  [ -n "$TARGET" ] && QUERY="?targetAgent=${TARGET}"
  [ -n "$ENABLED" ] && QUERY="${QUERY:+${QUERY}&}${QUERY:+}${QUERY:-?}enabled=${ENABLED}"
fi

api_call GET "/cron-tasks${QUERY}"
