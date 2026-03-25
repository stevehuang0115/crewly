#!/bin/bash
# Stop all agents in a team
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"team-uuid\"}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
require_param "teamId" "$TEAM_ID"

api_call POST "/teams/${TEAM_ID}/stop"
