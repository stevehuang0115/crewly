#!/bin/bash
# Team-Health-Watchdog (THW) — operator on-demand scan (§6.5).
#
# Usage:
#   execute.sh '{"teamId":"<optional>","force":<true|false>}'
#
# When force=true, POSTs /api/team-health/run for a fresh sweep.
# When force=false (default), GETs /api/team-health/scan?teamId=… for the
# cached last-sweep result.
#
# Layer-4 invariant: this skill is read-only. THW does not change agent
# status, claims, or work items — it only emits alerts.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
FORCE=$(printf '%s' "$INPUT" | jq -r '.force // false')

if [ "$FORCE" = "true" ]; then
  api_call POST "/team-health/run" "{}"
  exit 0
fi

urlencode() {
  local length="${#1}"
  for (( i = 0; i < length; i++ )); do
    local c="${1:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) printf "%s" "$c" ;;
      *) printf '%%%02X' "'$c" ;;
    esac
  done
}

if [ -n "$TEAM_ID" ]; then
  ENCODED_TEAM=$(urlencode "$TEAM_ID")
  api_call GET "/team-health/scan?teamId=${ENCODED_TEAM}"
else
  api_call GET "/team-health/scan"
fi
