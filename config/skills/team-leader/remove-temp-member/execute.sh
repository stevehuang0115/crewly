#!/bin/bash
# remove-temp-member — a team lead removes one of its TEMPORARY members
# early (its session is stopped and it leaves the team). Permanent members
# are refused: only the owner removes those.
# See specs/2026-11-26-temp-members-seat-requests.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --member "Temp-Developer-1"
  bash execute.sh --member <name | member id | session> --reason "launch moved" --team <team id>
  bash execute.sh --member "Temp-Developer-1" --force     Remove it although it is mid-turn or still holds work.
  bash execute.sh '{"member":"Temp-Developer-1","reason":"...","force":false,"teamId":"..."}'
--team defaults to your own team.
EOF_USAGE
}

TEAM_ID=""; MEMBER=""; REASON=""; FORCE="false"

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  J="$1"; shift
  TEAM_ID=$(printf '%s' "$J" | jq -r '.teamId // empty')
  MEMBER=$(printf '%s' "$J" | jq -r '.member // empty')
  REASON=$(printf '%s' "$J" | jq -r '.reason // empty')
  [ "$(printf '%s' "$J" | jq -r '.force // false')" = "true" ] && FORCE="true"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team|-g)    [ $# -ge 2 ] || error_exit "--team requires a value"; TEAM_ID="$2"; shift 2 ;;
    --member|-m)  [ $# -ge 2 ] || error_exit "--member requires a value"; MEMBER="$2"; shift 2 ;;
    --reason|-r)  [ $# -ge 2 ] || error_exit "--reason requires a value"; REASON="$2"; shift 2 ;;
    --force)      FORCE="true"; shift ;;
    --help|-h)    print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1 (see --help)" ;;
  esac
done

require_param "member" "$MEMBER"
[ -z "$TEAM_ID" ] && TEAM_ID=$(resolve_team_id || true)
[ -z "$TEAM_ID" ] && error_exit "Could not find your team: pass --team <team id>"

MEMBER_PATH=$(jq -rn --arg v "$MEMBER" '$v | @uri')
BODY=$(jq -n --arg reason "$REASON" --argjson force "$FORCE" \
  '{force: $force} + (if $reason != "" then {reason: $reason} else {} end)')

api_call DELETE "/teams/${TEAM_ID}/temp-members/${MEMBER_PATH}" "$BODY"
