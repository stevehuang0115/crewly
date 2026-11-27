#!/bin/bash
# Move an existing agent to another team (specs/2026-11-27-move-team-member.md).
#
# Usage:
#   execute.sh --member <name|session|id> --to <team name|id> [--from <team name|id>] [--allow-lead]
#   execute.sh '{"member":"Nova","to":"Growth","from":"Core","allowLead":false}'
#
# Looks the member and teams up in GET /teams, then calls
# POST /api/teams/:from/members/:member/move as the orchestrator; other agents
# get 403. Refusals come back with a `code` and a message, and change nothing.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

USAGE="Usage: execute.sh --member <name|session> --to <team name|id> [--from <team>] [--allow-lead]"
MEMBER=""
TO=""
FROM=""
ALLOW_LEAD="false"

if [ "${1:-}" != "" ] && [[ "${1}" == --* ]]; then
  while [ $# -gt 0 ]; do
    case "$1" in
      --member) MEMBER="${2:-}"; shift 2 ;;
      --to) TO="${2:-}"; shift 2 ;;
      --from) FROM="${2:-}"; shift 2 ;;
      --allow-lead) ALLOW_LEAD="true"; shift ;;
      *) error_exit "Unknown option: $1. ${USAGE}" ;;
    esac
  done
else
  INPUT=$(read_json_input "${1:-}")
  [ -z "$INPUT" ] && error_exit "$USAGE"
  MEMBER=$(printf '%s' "$INPUT" | jq -r '.member // .memberId // empty')
  TO=$(printf '%s' "$INPUT" | jq -r '.to // .toTeam // empty')
  FROM=$(printf '%s' "$INPUT" | jq -r '.from // .fromTeam // empty')
  ALLOW_LEAD=$(printf '%s' "$INPUT" | jq -r 'if .allowLead == true then "true" else "false" end')
fi

require_param "member" "$MEMBER"
require_param "to" "$TO"

# The whole list: a capped response would hide teams from the lookup.
RAW=$(CREWLY_SKILL_FULL_OUTPUT=1 api_call GET "/teams") || error_exit "Could not read the teams"
TEAMS=$(printf '%s' "$RAW" | tail -n 1 | jq -c 'if type == "array" then . else (.data // []) end') || error_exit "Could not read the team list"

# Teams matching an id or a name (case-insensitive); an id match wins.
find_teams() {
  printf '%s' "$TEAMS" | jq -c --arg q "$1" '
    ([.[] | select(.id == $q)]) as $byId
    | if ($byId | length) > 0 then $byId
      else [.[] | select((.name // "" | ascii_downcase) == ($q | ascii_downcase))] end'
}

one_team_id() {
  local found count
  found=$(find_teams "$1")
  count=$(printf '%s' "$found" | jq 'length')
  [ "$count" -eq 1 ] || error_exit "$([ "$count" -eq 0 ] && echo "No team" || echo "More than one team") matches \"$1\"; use the team id"
  printf '%s' "$found" | jq -r '.[0].id'
}

TO_ID=$(one_team_id "$TO")
FROM_ID=""
if [ -n "$FROM" ]; then
  FROM_ID=$(one_team_id "$FROM")
fi

# Members matching session, agent id or member id; else the name.
MATCHES=$(printf '%s' "$TEAMS" | jq -c --arg q "$MEMBER" --arg from "$FROM_ID" '
  [.[] | select($from == "" or .id == $from) | . as $t | (.members // [])[]
    | {teamId: $t.id, team: $t.name, memberId: .id, name, sessionName: (.sessionName // ""), agentId: (.agentId // "")}] as $all
  | [$all[] | select(.sessionName == $q or .agentId == $q or .memberId == $q)] as $exact
  | if ($exact | length) > 0 then $exact
    else [$all[] | select((.name // "" | ascii_downcase) == ($q | ascii_downcase))] end')
COUNT=$(printf '%s' "$MATCHES" | jq 'length')
if [ "$COUNT" -eq 0 ]; then
  error_exit "No member matches \"${MEMBER}\"${FROM:+ in team \"${FROM}\"}"
fi
if [ "$COUNT" -gt 1 ]; then
  CHOICES=$(printf '%s' "$MATCHES" | jq -r 'map("\(.name) on \(.team) (\(if .sessionName != "" then .sessionName else .memberId end))") | join("; ")')
  error_exit "More than one member matches \"${MEMBER}\": ${CHOICES}. Pass the session name, or --from"
fi

SOURCE_ID=$(printf '%s' "$MATCHES" | jq -r '.[0].teamId')
MEMBER_ID=$(printf '%s' "$MATCHES" | jq -r '.[0].memberId')
if [ "$SOURCE_ID" = "$TO_ID" ]; then
  error_exit "\"${MEMBER}\" is already on that team; nothing to move"
fi

SOURCE_PATH=$(jq -rn --arg t "$SOURCE_ID" '$t | @uri')
MEMBER_PATH=$(jq -rn --arg m "$MEMBER_ID" '$m | @uri')
BODY=$(jq -n --arg to "$TO_ID" --argjson allow "$ALLOW_LEAD" '{toTeamId: $to, allowLead: $allow}')

RESULT=$(api_call POST "/teams/${SOURCE_PATH}/members/${MEMBER_PATH}/move" "$BODY")
printf '%s' "$RESULT" | tail -n 1 | jq '
  if .data then .data + {summary: (
    "Moved \(.data.member.name) (\(.data.member.sessionName)) from \(.data.from.name) to \(.data.to.name). "
    + "Updated: \(.data.updated.workItems | length) work item(s), \(.data.updated.triggers | length) followup(s), "
    + "\(.data.updated.cronTasks | length) cron task(s), \(.data.updated.decisions | length) open decision(s)."
    + (if .data.restartRequired then " Restart the agent so it loads the new team." else " It loads the new team at its next start." end)
  )} else . end'
