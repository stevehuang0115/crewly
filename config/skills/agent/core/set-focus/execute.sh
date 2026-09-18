#!/bin/bash
# =============================================================================
# set-focus — Replace the agent's focus list (attention management)
#
# Backed by POST /api/agents/:sessionName/self-improvement/attention/focus.
# Focus items are injected into the agent's prompt (≤5) and pruned after two
# weeks without an update.
#
# Usage:
#   bash execute.sh --item "ship v2" --item "flaky CI" [--session crewly-dev-1]
#   bash execute.sh '{"items":["ship v2","flaky CI"],"sessionName":"crewly-dev-1"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --item "ship v2" --item "flaky CI" [--session crewly-dev-1]
  bash execute.sh '{"items":["ship v2","flaky CI"]}'

Options:
  --item    | -i   Focus item (repeat for several; at least one required)
  --session | -s   Session name (defaults to $CREWLY_SESSION_NAME)
  --help    | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
ITEMS_JSON='[]'

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --item|-i)
      [ $# -ge 2 ] || error_exit "--item requires a value"
      ITEMS_JSON=$(jq -cn --argjson arr "$ITEMS_JSON" --arg v "$2" '$arr + [$v]')
      shift 2 ;;
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
  if [ "$(printf '%s' "$ITEMS_JSON" | jq 'length')" -eq 0 ]; then
    ITEMS_JSON=$(printf '%s' "$INPUT" | jq -c '(.items // []) | if type == "string" then [.] else . end')
  fi
fi

[ -z "$SESSION_NAME" ] && SESSION_NAME="${CREWLY_SESSION_NAME:-}"
require_param "sessionName (--session or CREWLY_SESSION_NAME)" "$SESSION_NAME"
[ "$(printf '%s' "$ITEMS_JSON" | jq 'length')" -gt 0 ] || error_exit "Missing required parameter: items (--item)"

BODY=$(jq -cn --argjson items "$ITEMS_JSON" '{items: $items}')

RESPONSE=$(api_call POST "/agents/${SESSION_NAME}/self-improvement/attention/focus" "$BODY" 2>&1) || {
  ERROR_MSG=$(printf '%s' "$RESPONSE" | jq -r '.details.error // .details // .error // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  jq -n --arg reason "$ERROR_MSG" '{success: false, reason: $reason}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), focus: (.data.focus // []), suppressed: (.data.suppressed // [])}'
