#!/bin/bash
# Assign teams to a project
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"projectId\":\"project-uuid\",\"teamIds\":[\"team-uuid-1\"]}'"

PROJECT_ID=$(printf '%s' "$INPUT" | jq -r '.projectId // empty')
require_param "projectId" "$PROJECT_ID"

# Pass the full input as the request body (backend expects teamIds array)
api_call POST "/projects/${PROJECT_ID}/teams" "$INPUT"
