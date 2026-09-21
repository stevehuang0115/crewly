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

Output: JSON object { success, examined, count, data: [Trigger, ...] }
  examined = triggers received from the backend BEFORE the team filter;
  count    = triggers left after the team/status/prefix filters.
  A truncated or malformed response is an error (exit 1), never count 0.
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

# GET /triggers is the whole trigger table (335 rows / 233 KB on 2026-09-21),
# well over the skill-output cap. Plain api_call would hand back a
# {"truncated":true} envelope and `.data // []` would turn that into an empty
# list with success:true. api_call_full returns the real body or fails.
if ! LIST_RESP=$(api_call_full GET "/triggers" ""); then
  jq -n '{success:false, examined:0, error:"GET /triggers failed or came back as a truncated envelope; refusing to report an empty follow-up list"}'
  exit 1
fi

# A guard must report what it examined, not just its verdict. `.data` has to be
# an array; an envelope, an error object or anything else is an UNKNOWN result,
# not "no triggers" — refuse rather than print success with count 0.
EXAMINED=$(printf '%s' "$LIST_RESP" | jq -r 'if type == "object" then (if (.data | type) == "array" then (.data | length) else "not-an-array" end) else "not-an-object" end' 2>/dev/null || echo "unparseable")
if ! [ "$EXAMINED" -ge 0 ] 2>/dev/null; then
  jq -n --arg why "$EXAMINED" --arg head "${LIST_RESP:0:200}" \
    '{success:false, examined:0, error:("GET /triggers returned a body whose .data is " + $why + "; refusing to report an empty follow-up list"), head:$head}'
  exit 1
fi

FILTERED=$(printf '%s' "$LIST_RESP" | jq \
  --arg team "$TEAM_ID" \
  --arg status "$STATUS_FILTER" \
  --arg prefix "$NAME_PREFIX" \
  '(.data // [])
    | map(select(.teamId == $team))
    | (if $status != "" then map(select(.status == $status)) else . end)
    | (if $prefix != "" then map(select(.name != null and (.name | startswith($prefix)))) else . end)')

COUNT=$(printf '%s' "$FILTERED" | jq 'length')
printf '%s' "$FILTERED" | jq --arg c "$COUNT" --arg e "$EXAMINED" \
  '{success:true, examined:($e|tonumber), count:($c|tonumber), data:.}'
