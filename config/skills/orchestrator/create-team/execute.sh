#!/bin/bash
# Create a new agent team
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"name\":\"Alpha\",\"description\":\"...\",\"members\":[{\"name\":\"dev1\",\"role\":\"developer\"}]}'"

NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
require_param "name" "$NAME"

# Pass the full input as the request body (backend expects name, description, members)
api_call POST "/teams" "$INPUT"
