#!/bin/bash
# =============================================================================
# record-prediction — Record a prediction with a confidence level
#
# Backed by POST /api/agents/:sessionName/self-improvement/predictions.
#
# Usage:
#   bash execute.sh --statement "PR lands today" --confidence 0.7 [--resolve-by 2026-10-01] [--session crewly-dev-1]
#   bash execute.sh '{"statement":"PR lands today","confidence":0.7,"resolveBy":"2026-10-01"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --statement "PR lands today" --confidence 0.7 [--resolve-by 2026-10-01] [--session crewly-dev-1]
  bash execute.sh '{"statement":"PR lands today","confidence":0.7}'

Options:
  --statement  | -p   What you predict (required)
  --confidence | -c   Confidence 0-1 (required)
  --resolve-by        ISO date the prediction should be resolved by (optional)
  --session    | -s   Session name (defaults to $CREWLY_SESSION_NAME)
  --help       | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
STATEMENT=""
CONFIDENCE=""
RESOLVE_BY=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --statement|-p)
      [ $# -ge 2 ] || error_exit "--statement requires a value"
      STATEMENT="$2"; shift 2 ;;
    --confidence|-c)
      [ $# -ge 2 ] || error_exit "--confidence requires a value"
      CONFIDENCE="$2"; shift 2 ;;
    --resolve-by)
      [ $# -ge 2 ] || error_exit "--resolve-by requires a value"
      RESOLVE_BY="$2"; shift 2 ;;
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
  [ -z "$STATEMENT" ] && STATEMENT=$(printf '%s' "$INPUT" | jq -r '.statement // .prediction // empty')
  [ -z "$CONFIDENCE" ] && CONFIDENCE=$(printf '%s' "$INPUT" | jq -r 'if .confidence == null then empty else (.confidence | tostring) end')
  [ -z "$RESOLVE_BY" ] && RESOLVE_BY=$(printf '%s' "$INPUT" | jq -r '.resolveBy // empty')
fi

[ -z "$SESSION_NAME" ] && SESSION_NAME="${CREWLY_SESSION_NAME:-}"
require_param "sessionName (--session or CREWLY_SESSION_NAME)" "$SESSION_NAME"
require_param "statement (--statement)" "$STATEMENT"
require_param "confidence (--confidence)" "$CONFIDENCE"

# Validate locally so a typo fails fast with a readable message.
if ! printf '%s' "$CONFIDENCE" | grep -Eq '^(0(\.[0-9]+)?|1(\.0+)?)$'; then
  error_exit "confidence must be a number between 0 and 1 (got: $CONFIDENCE)"
fi

if [ -n "$RESOLVE_BY" ]; then
  BODY=$(jq -cn --arg s "$STATEMENT" --argjson c "$CONFIDENCE" --arg r "$RESOLVE_BY" '{statement: $s, confidence: $c, resolveBy: $r}')
else
  BODY=$(jq -cn --arg s "$STATEMENT" --argjson c "$CONFIDENCE" '{statement: $s, confidence: $c}')
fi

RESPONSE=$(api_call POST "/agents/${SESSION_NAME}/self-improvement/predictions" "$BODY" 2>&1) || {
  ERROR_MSG=$(printf '%s' "$RESPONSE" | jq -r '.details.error // .details // .error // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  jq -n --arg reason "$ERROR_MSG" '{success: false, reason: $reason}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), id: (.data.prediction.id // null), prediction: (.data.prediction // null)}'
