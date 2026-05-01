#!/bin/bash
# get-my-active-work — fetch the live Request + WorkItem briefing for this
# agent. Backs the recovery protocol's Step 1.5 freshness escape hatch:
# the startup briefing is already injected at registration time, but a
# long-running session can call this skill to refresh after the snapshot
# ages out (e.g. >5min after registration).
#
# Mirrors the get-my-tasks skill argument shape for consistency.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred — avoids shell escaping issues)
  bash execute.sh --session dev-1
  bash execute.sh --session dev-1 --role developer --format markdown

  # Legacy JSON argument (backward compatible)
  bash execute.sh '{"sessionName":"dev-1","role":"developer"}'

Options:
  --session  | -s   Agent session name (required)
  --role     | -r   Agent role (default: developer; orchestrator gets 3x cap)
  --format   | -f   "json" (default) or "markdown"
  --window   | -w   Recently-resolved window in milliseconds (default: 1800000 / 30min)
  --json     | -j   Raw JSON payload (same as legacy)
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
ROLE=""
FORMAT=""
WINDOW_MS=""

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session|-s)
      SESSION_NAME="$2"
      shift 2
      ;;
    --role|-r)
      ROLE="$2"
      shift 2
      ;;
    --format|-f)
      FORMAT="$2"
      shift 2
      ;;
    --window|-w)
      WINDOW_MS="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"
        shift
      else
        error_exit "Unknown argument: $1. Use --help for usage."
      fi
      ;;
  esac
done

# If nothing provided yet but stdin has data, read it as JSON
if [ -z "$INPUT_JSON" ] && [ -z "$SESSION_NAME" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON input if provided (backward compatible)
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
  [ -z "$ROLE" ]         && ROLE=$(printf '%s'         "$INPUT" | jq -r '.role         // empty')
  [ -z "$FORMAT" ]       && FORMAT=$(printf '%s'       "$INPUT" | jq -r '.format       // empty')
  [ -z "$WINDOW_MS" ]    && WINDOW_MS=$(printf '%s'    "$INPUT" | jq -r '(.recentlyResolvedWindowMs // empty) | tostring')
  # `jq` returns the literal string "null" when the field is missing — coerce.
  [ "$WINDOW_MS" = "null" ] && WINDOW_MS=""
fi

require_param "sessionName (--session)" "$SESSION_NAME"

# Defaults for optional knobs
[ -z "$ROLE" ]   && ROLE="developer"
[ -z "$FORMAT" ] && FORMAT="json"

# URL-encode the session name and build the query string
ENCODED_SESSION=$(printf '%s' "$SESSION_NAME" | jq -sRr @uri)
ENCODED_ROLE=$(printf '%s'    "$ROLE"         | jq -sRr @uri)
ENCODED_FORMAT=$(printf '%s'  "$FORMAT"       | jq -sRr @uri)

QUERY="role=${ENCODED_ROLE}&format=${ENCODED_FORMAT}"
if [ -n "$WINDOW_MS" ]; then
  ENCODED_WINDOW=$(printf '%s' "$WINDOW_MS" | jq -sRr @uri)
  QUERY="${QUERY}&recentlyResolvedWindowMs=${ENCODED_WINDOW}"
fi

api_call GET "/v3/agents/${ENCODED_SESSION}/active-work?${QUERY}"
