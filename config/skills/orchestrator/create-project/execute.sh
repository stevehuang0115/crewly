#!/bin/bash
# Create a new project in Crewly
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"path\":\"/absolute/path/to/project\",\"name\":\"My Project\",\"description\":\"...\"}'"

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.path // empty')
require_param "path" "$PROJECT_PATH"

# Pass the full input as the request body (backend expects path, name, description)
api_call POST "/projects" "$INPUT"
