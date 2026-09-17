#!/bin/bash
# Get status of all teams and their agents.
#
# Compact by default (2026-09-16): the raw /teams payload carries every
# member's system prompt, and on a workspace with a few teams that is ~50 KB
# per call — all of which stays in the orchestrator's context for the rest of
# the session. Pass --full (or {"full":true}) when a specific field is needed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

FULL="false"
for arg in "$@"; do
  case "$arg" in
    --full) FULL="true" ;;
    \{*) printf '%s' "$arg" | jq -e '.full == true' >/dev/null 2>&1 && FULL="true" ;;
  esac
done

RAW=$(api_call GET "/teams")

if [ "$FULL" = "true" ]; then
  printf '%s\n' "$RAW"
  exit 0
fi

printf '%s' "$RAW" | jq '
  def compact_member: {name, sessionName, role, runtimeType, agentStatus, workingStatus, readyAt};
  def compact_team: {id, name, projectIds, memberCount: ((.members // []) | length), members: [(.members // [])[] | compact_member]};
  if type == "array" then map(compact_team)
  elif (.data | type) == "array" then .data |= map(compact_team)
  elif .members then compact_team
  else . end'
