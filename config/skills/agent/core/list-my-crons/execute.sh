#!/bin/bash
# List the recurring cron tasks that target YOU (or another agent via --target).
#
# Cron tasks and follow-up triggers live in two different stores. This skill
# reads the cron-tasks store (what the orchestrator schedules FOR an agent),
# which `list-my-followups` does NOT cover. Call this before self-scheduling so
# you don't stack a duplicate cron that fires N× reports per trigger (#621).
#
# Supports CLI flags (preferred) or legacy JSON.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh                      # All crons targeting you
  bash execute.sh --enabled true       # Only enabled crons targeting you
  bash execute.sh --target <session>   # Crons targeting another agent

Options:
  --enabled   One of: true | false (optional)
  --target    Agent session to query (default: yourself, $CREWLY_SESSION_NAME)
  --json -j   Raw JSON payload (legacy)
  --help -h   Show this help

Output: JSON object { success, count, data: [CronTask, ...] }
EOF_USAGE
}

INPUT_JSON=""
ENABLED_FILTER=""
TARGET=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --enabled)   ENABLED_FILTER="$2"; shift 2 ;;
    --target)    TARGET="$2"; shift 2 ;;
    --json|-j)   INPUT_JSON="$2"; shift 2 ;;
    --help|-h)   print_usage; exit 0 ;;
    --)          shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"; shift
      else
        echo '{"error":"Unknown argument: '"$1"'"}' >&2
        exit 1
      fi
      ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  ENABLED_FILTER=$(printf '%s' "$INPUT_JSON" | jq -r '.enabled // empty')
  TARGET=$(printf '%s' "$INPUT_JSON" | jq -r '.target // empty')
fi

# Default target = self
[ -z "$TARGET" ] && TARGET="${CREWLY_SESSION_NAME:-}"
[ -z "$TARGET" ] && { echo '{"error":"No --target and CREWLY_SESSION_NAME is unset"}' >&2; exit 1; }

# Build query string: filter by targetAgent (Option A from #621 — the API
# returns crons where targetAgent == session, regardless of who created them).
QUERY="?targetAgent=${TARGET}"
[ -n "$ENABLED_FILTER" ] && QUERY="${QUERY}&enabled=${ENABLED_FILTER}"

LIST_RESP=$(api_call GET "/cron-tasks${QUERY}" "")

# Normalise to { success, count, data } so callers get a stable shape.
DATA=$(printf '%s' "$LIST_RESP" | jq '(.data // [])')
COUNT=$(printf '%s' "$DATA" | jq 'length')
printf '%s' "$DATA" | jq --arg c "$COUNT" '{success:true, count:($c|tonumber), data:.}'
