#!/bin/bash
# Start all agents in a team
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"team-uuid\",\"projectId\":\"project-uuid\"}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
require_param "teamId" "$TEAM_ID"

# Pass the full input as the request body (backend accepts optional projectId)
api_call POST "/teams/${TEAM_ID}/start" "$INPUT"
