#!/bin/bash
# Update an existing team (name, description, or members)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"uuid\",\"name\":\"New Name\",\"description\":\"...\"}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
require_param "teamId" "$TEAM_ID"

# Remove teamId from the body before sending (it's in the URL)
BODY=$(printf '%s' "$INPUT" | jq 'del(.teamId)')

api_call PUT "/teams/$TEAM_ID" "$BODY"
