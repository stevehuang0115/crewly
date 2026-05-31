#!/bin/bash
# Query standard operating procedures relevant to the current context
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"context\":\"deploying to production\"}'"

CONTEXT=$(printf '%s' "$INPUT" | jq -r '.context // empty')
require_param "context" "$CONTEXT"

CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // empty')
ROLE=$(printf '%s' "$INPUT" | jq -r '.role // empty')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')

# Resolve teamId so the backend can also surface THIS team's installed/custom
# SOP library (~/.crewly/teams/<id>/sops/), not just the global store.
CREWLY_HOME="${HOME}/.crewly"
resolve_team_id() {
  local session="${1:-${CREWLY_SESSION_NAME:-}}"
  [ -z "$session" ] && return 1
  local teams_dir="${CREWLY_HOME}/teams"
  [ ! -d "$teams_dir" ] && return 1
  for config in "$teams_dir"/*/config.json; do
    [ -f "$config" ] || continue
    if [ "$(jq -r --arg s "$session" '.members[]? | select(.sessionName == $s) | "found"' "$config" 2>/dev/null | head -1)" = "found" ]; then
      basename "$(dirname "$config")"
      return 0
    fi
  done
  return 1
}
if [ -z "$TEAM_ID" ]; then
  TEAM_ID=$(resolve_team_id "$SESSION_NAME" || true)
fi

BODY=$(jq -n \
  --arg context "$CONTEXT" \
  --arg category "$CATEGORY" \
  --arg role "$ROLE" \
  --arg teamId "$TEAM_ID" \
  '{context: $context} +
   (if $category != "" then {category: $category} else {} end) +
   (if $role != "" then {role: $role} else {} end) +
   (if $teamId != "" then {teamId: $teamId} else {} end)')

api_call POST "/system/sops/query" "$BODY"
