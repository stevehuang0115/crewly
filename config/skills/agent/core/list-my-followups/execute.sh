#!/bin/bash
# List all follow-up triggers owned by your team. Useful for stock-taking
# before adding a new watcher (so you don't stack duplicates), or for
# auditing why something keeps firing.
#
# Supports CLI flags or legacy JSON.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh                            # All triggers owned by your team
  bash execute.sh --status active            # Only active ones
  bash execute.sh --name-prefix followup:    # Filter by name prefix

Options:
  --status        One of: active | paused | exhausted | cancelled (optional)
  --name-prefix   Only return triggers whose name starts with this string
  --json   -j     Raw JSON payload (legacy)
  --help   -h     Show this help

Output: JSON object { success, count, data: [Trigger, ...] }
EOF_USAGE
}

INPUT_JSON=""
STATUS_FILTER=""
NAME_PREFIX=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)         STATUS_FILTER="$2"; shift 2 ;;
    --name-prefix)    NAME_PREFIX="$2"; shift 2 ;;
    --json|-j)        INPUT_JSON="$2"; shift 2 ;;
    --help|-h)        print_usage; exit 0 ;;
    --)               shift; break ;;
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
  STATUS_FILTER=$(printf '%s' "$INPUT_JSON" | jq -r '.status // empty')
  NAME_PREFIX=$(printf '%s' "$INPUT_JSON" | jq -r '.namePrefix // empty')
fi

TEAM_ID=$(resolve_team_id || true)
[ -z "$TEAM_ID" ] && { echo '{"error":"Cannot resolve owning team from CREWLY_SESSION_NAME"}' >&2; exit 1; }

LIST_RESP=$(api_call GET "/triggers" "")
FILTERED=$(printf '%s' "$LIST_RESP" | jq \
  --arg team "$TEAM_ID" \
  --arg status "$STATUS_FILTER" \
  --arg prefix "$NAME_PREFIX" \
  '(.data // [])
    | map(select(.teamId == $team))
    | (if $status != "" then map(select(.status == $status)) else . end)
    | (if $prefix != "" then map(select(.name != null and (.name | startswith($prefix)))) else . end)')

COUNT=$(printf '%s' "$FILTERED" | jq 'length')
printf '%s' "$FILTERED" | jq --arg c "$COUNT" '{success:true, count:($c|tonumber), data:.}'
