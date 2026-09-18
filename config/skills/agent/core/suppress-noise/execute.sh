#!/bin/bash
# =============================================================================
# suppress-noise — Add a topic to the agent's suppressed list
#
# Backed by POST /api/agents/:sessionName/self-improvement/attention/suppress.
#
# Usage:
#   bash execute.sh --item "legacy webhooks" [--session crewly-dev-1]
#   bash execute.sh '{"item":"legacy webhooks","sessionName":"crewly-dev-1"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --item "legacy webhooks" [--session crewly-dev-1]
  bash execute.sh '{"item":"legacy webhooks"}'

Options:
  --item    | -i   Topic to suppress (required)
  --session | -s   Session name (defaults to $CREWLY_SESSION_NAME)
  --help    | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
ITEM=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --item|-i)
      [ $# -ge 2 ] || error_exit "--item requires a value"
      ITEM="$2"; shift 2 ;;
    --session|-s)
      [ $# -ge 2 ] || error_exit "--session requires a value"
      SESSION_NAME="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // .agentId // empty')
  [ -z "$ITEM" ] && ITEM=$(printf '%s' "$INPUT" | jq -r '.item // empty')
fi

[ -z "$SESSION_NAME" ] && SESSION_NAME="${CREWLY_SESSION_NAME:-}"
require_param "sessionName (--session or CREWLY_SESSION_NAME)" "$SESSION_NAME"
require_param "item (--item)" "$ITEM"

BODY=$(jq -cn --arg item "$ITEM" '{item: $item}')

RESPONSE=$(api_call POST "/agents/${SESSION_NAME}/self-improvement/attention/suppress" "$BODY" 2>&1) || {
  ERROR_MSG=$(printf '%s' "$RESPONSE" | jq -r '.details.error // .details // .error // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  jq -n --arg reason "$ERROR_MSG" '{success: false, reason: $reason}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), focus: (.data.focus // []), suppressed: (.data.suppressed // [])}'
