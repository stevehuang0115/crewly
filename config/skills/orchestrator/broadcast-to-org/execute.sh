#!/bin/bash
# Broadcast a message to all Team Leaders within an organization (parent team's child teams).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"parentTeamId\":\"org-team-id\",\"message\":\"Please submit status reports\"}'"

PARENT_TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.parentTeamId // empty')
MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
require_param "parentTeamId" "$PARENT_TEAM_ID"
require_param "message" "$MESSAGE"

# Fetch all teams
ALL_TEAMS=$(api_call GET "/teams" 2>/dev/null) || error_exit "Failed to fetch teams"

# Verify parent team exists
PARENT_EXISTS=$(echo "$ALL_TEAMS" | jq -r --arg pid "$PARENT_TEAM_ID" \
  '[.data // . | if type == "array" then .[] else empty end | select(.id == $pid)] | length' 2>/dev/null || echo "0")

if [ "$PARENT_EXISTS" = "0" ]; then
  error_exit "Parent team '${PARENT_TEAM_ID}' not found"
fi

# Find child teams whose parentTeamId matches
CHILD_TEAMS=$(echo "$ALL_TEAMS" | jq -c --arg pid "$PARENT_TEAM_ID" \
  '[.data // . | if type == "array" then .[] else empty end | select(.parentTeamId == $pid)]' 2>/dev/null || echo "[]")

CHILD_COUNT=$(echo "$CHILD_TEAMS" | jq 'length')

if [ "$CHILD_COUNT" = "0" ]; then
  echo "{\"sent\":0,\"failed\":0,\"skipped\":0,\"message\":\"No child teams found under parent ${PARENT_TEAM_ID}\"}"
  exit 0
fi

SENT=0
FAILED=0
SKIPPED=0
DETAILS="[]"

# Iterate through child teams and find their leaders
for i in $(seq 0 $((CHILD_COUNT - 1))); do
  TEAM=$(echo "$CHILD_TEAMS" | jq -c ".[$i]")
  TEAM_NAME=$(echo "$TEAM" | jq -r '.name // "unknown"')

  # Find leader sessions: use leaderIds first, fallback to hierarchyLevel==1
  LEADER_SESSIONS=$(echo "$TEAM" | jq -r '
    if (.leaderIds // []) | length > 0 then
      .members[] | select(.id as $id | any(.leaderIds[]; . == $id)) | .sessionName // empty
    else
      .members[] | select(.hierarchyLevel == 1) | .sessionName // empty
    end
  ' 2>/dev/null || true)

  # Fallback: look for team-leader role
  if [ -z "$LEADER_SESSIONS" ]; then
    LEADER_SESSIONS=$(echo "$TEAM" | jq -r '.members[] | select(.role == "team-leader") | .sessionName // empty' 2>/dev/null || true)
  fi

  if [ -z "$LEADER_SESSIONS" ]; then
    SKIPPED=$((SKIPPED + 1))
    DETAILS=$(echo "$DETAILS" | jq --arg team "$TEAM_NAME" '. + [{"team": $team, "status": "skipped", "reason": "no leader found"}]')
    continue
  fi

  for SESSION in $LEADER_SESSIONS; do
    [ -z "$SESSION" ] && continue
    BODY=$(jq -n --arg message "$MESSAGE" '{message: $message}')
    if api_call POST "/terminal/${SESSION}/deliver" "$BODY" >/dev/null 2>&1; then
      SENT=$((SENT + 1))
      DETAILS=$(echo "$DETAILS" | jq --arg team "$TEAM_NAME" --arg session "$SESSION" \
        '. + [{"team": $team, "session": $session, "status": "sent"}]')
    else
      FAILED=$((FAILED + 1))
      DETAILS=$(echo "$DETAILS" | jq --arg team "$TEAM_NAME" --arg session "$SESSION" \
        '. + [{"team": $team, "session": $session, "status": "failed"}]')
    fi
  done
done

jq -n \
  --argjson sent "$SENT" \
  --argjson failed "$FAILED" \
  --argjson skipped "$SKIPPED" \
  --argjson childTeams "$CHILD_COUNT" \
  --argjson details "$DETAILS" \
  '{sent: $sent, failed: $failed, skipped: $skipped, childTeams: $childTeams, details: $details, message: "Broadcast to organization complete"}'
