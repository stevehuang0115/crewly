#!/bin/bash
# Cancel a previously scheduled follow-up trigger. Accepts either the trigger
# id (returned by schedule-followup / watch-for-event) or the stable `name`.
#
# Call this the moment a task is confirmed done — don't rely on maxIdleFires
# as your only safety net when you *know* the work is finished.
#
# Supports CLI flags (preferred), legacy JSON, stdin pipe, or @filepath.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # Cancel by id (preferred when you still have the return value)
  bash execute.sh --id 123e4567-e89b-12d3-a456-426614174000

  # Cancel by stable name (scoped to your team)
  bash execute.sh --name "followup:abc12345"

  # Legacy JSON
  bash execute.sh '{"id":"..."}'

Options:
  --id         Trigger UUID (exact match)
  --name       Stable name (scoped to your team — only cancels triggers owned
               by your team, never another team's)
  --json  -j   Raw JSON payload (legacy)
  --help  -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
TRIGGER_ID=""
TRIGGER_NAME=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)        TRIGGER_ID="$2"; shift 2 ;;
    --name)      TRIGGER_NAME="$2"; shift 2 ;;
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
  TRIGGER_ID=$(printf '%s' "$INPUT_JSON" | jq -r '.id // empty')
  TRIGGER_NAME=$(printf '%s' "$INPUT_JSON" | jq -r '.name // empty')
fi

if [ -z "$TRIGGER_ID" ] && [ -z "$TRIGGER_NAME" ]; then
  echo '{"error":"One of --id or --name is required"}' >&2
  exit 1
fi

# Resolve by name — list triggers, find the one owned by this team with matching name.
if [ -z "$TRIGGER_ID" ]; then
  TEAM_ID=$(resolve_team_id || true)
  [ -z "$TEAM_ID" ] && { echo '{"error":"Cannot resolve owning team — cannot scope name lookup"}' >&2; exit 1; }

  LIST_RESP=$(api_call GET "/triggers" "" 2>/dev/null || echo '{"data":[]}')
  TRIGGER_ID=$(printf '%s' "$LIST_RESP" | jq -r \
    --arg team "$TEAM_ID" \
    --arg name "$TRIGGER_NAME" \
    '(.data // [] | .[]
       | select(.teamId == $team and .name == $name and .status == "active")
       | .id) // empty' | head -1)

  if [ -z "$TRIGGER_ID" ]; then
    echo "$(jq -n --arg n "$TRIGGER_NAME" --arg team "$TEAM_ID" \
      '{success:false, error:"No active trigger found with name", name:$n, teamId:$team}')"
    exit 0
  fi
fi

RESP=$(api_call POST "/triggers/${TRIGGER_ID}/cancel" "")
echo "$RESP"
