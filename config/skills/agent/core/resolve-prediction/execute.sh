#!/bin/bash
# =============================================================================
# resolve-prediction — Close a prediction with its actual outcome
#
# Backed by POST /api/agents/:sessionName/self-improvement/predictions/:id/resolve.
#
# Usage:
#   bash execute.sh --id pred-123 --outcome "merged Thursday" --accurate true [--session crewly-dev-1]
#   bash execute.sh --id pred-123 --outcome wrong
#   bash execute.sh '{"id":"pred-123","outcome":"slipped","accurate":false}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id pred-123 --outcome "merged Thursday" --accurate true [--session crewly-dev-1]
  bash execute.sh --id pred-123 --outcome wrong
  bash execute.sh '{"id":"pred-123","outcome":"slipped","accurate":false}'

Options:
  --id               Prediction id (required)
  --outcome  | -o    What actually happened (required)
  --accurate | -a    true|false (required unless outcome is a plain verdict like "correct"/"wrong")
  --session  | -s    Session name (defaults to $CREWLY_SESSION_NAME)
  --help     | -h    Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
PRED_ID=""
OUTCOME=""
ACCURATE=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)
      [ $# -ge 2 ] || error_exit "--id requires a value"
      PRED_ID="$2"; shift 2 ;;
    --outcome|-o)
      [ $# -ge 2 ] || error_exit "--outcome requires a value"
      OUTCOME="$2"; shift 2 ;;
    --accurate|-a)
      [ $# -ge 2 ] || error_exit "--accurate requires a value"
      ACCURATE="$2"; shift 2 ;;
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
  [ -z "$PRED_ID" ] && PRED_ID=$(printf '%s' "$INPUT" | jq -r '.id // .predictionId // empty')
  [ -z "$OUTCOME" ] && OUTCOME=$(printf '%s' "$INPUT" | jq -r '.outcome // empty')
  [ -z "$ACCURATE" ] && ACCURATE=$(printf '%s' "$INPUT" | jq -r 'if .accurate == null then empty else (.accurate | tostring) end')
fi

[ -z "$SESSION_NAME" ] && SESSION_NAME="${CREWLY_SESSION_NAME:-}"
require_param "sessionName (--session or CREWLY_SESSION_NAME)" "$SESSION_NAME"
require_param "id (--id)" "$PRED_ID"
require_param "outcome (--outcome)" "$OUTCOME"

case "$ACCURATE" in
  "") BODY=$(jq -cn --arg o "$OUTCOME" '{outcome: $o}') ;;
  true|false) BODY=$(jq -cn --arg o "$OUTCOME" --argjson a "$ACCURATE" '{outcome: $o, accurate: $a}') ;;
  *) error_exit "accurate must be true or false (got: $ACCURATE)" ;;
esac

RESPONSE=$(api_call POST "/agents/${SESSION_NAME}/self-improvement/predictions/${PRED_ID}/resolve" "$BODY" 2>&1) || {
  ERROR_MSG=$(printf '%s' "$RESPONSE" | jq -r '.details.error // .details // .error // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  jq -n --arg reason "$ERROR_MSG" '{success: false, reason: $reason}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), prediction: (.data.prediction // null), calibrationScore: (.data.calibrationScore // null)}'
