#!/bin/bash
# request-seat — a team lead asks the owner for a PERMANENT seat on its team.
# One owner card (Approve / Not now) carries the reason and the evidence
# Crewly adds itself. Nothing changes until the owner approves.
# See specs/2026-11-26-temp-members-seat-requests.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --role developer --reason "client work needs a second developer every week"
  bash execute.sh --role designer --reason "..." --name "Kai" --team <team id>
  bash execute.sh '{"role":"developer","reason":"...","name":"Kai","teamId":"..."}'
--team defaults to your own team. One open request per role; after "Not now" the same role waits 14 days.
EOF_USAGE
}

TEAM_ID=""; ROLE=""; REASON=""; NAME=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  J="$1"; shift
  TEAM_ID=$(printf '%s' "$J" | jq -r '.teamId // empty')
  ROLE=$(printf '%s' "$J" | jq -r '.role // empty')
  REASON=$(printf '%s' "$J" | jq -r '.reason // empty')
  NAME=$(printf '%s' "$J" | jq -r '.name // empty')
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team|-g)    [ $# -ge 2 ] || error_exit "--team requires a value"; TEAM_ID="$2"; shift 2 ;;
    --role)       [ $# -ge 2 ] || error_exit "--role requires a value"; ROLE="$2"; shift 2 ;;
    --reason|-r)  [ $# -ge 2 ] || error_exit "--reason requires a value"; REASON="$2"; shift 2 ;;
    --name|-n)    [ $# -ge 2 ] || error_exit "--name requires a value"; NAME="$2"; shift 2 ;;
    --help|-h)    print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1 (see --help)" ;;
  esac
done

require_param "role" "$ROLE"
require_param "reason" "$REASON"
[ -z "$TEAM_ID" ] && TEAM_ID=$(resolve_team_id || true)
[ -z "$TEAM_ID" ] && error_exit "Could not find your team: pass --team <team id>"

BODY=$(jq -n --arg role "$ROLE" --arg reason "$REASON" --arg name "$NAME" \
  '{role: $role, reason: $reason} + (if $name != "" then {name: $name} else {} end)')

api_call POST "/teams/${TEAM_ID}/seat-requests" "$BODY"
