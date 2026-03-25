#!/bin/bash
# Get task progress and overview for the team
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"projectPath\":\"/path/to/project\"}'"

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
require_param "projectPath" "$PROJECT_PATH"

# URL-encode the project path
urlencode() {
    local length="${#1}"
    for (( i = 0; i < length; i++ )); do
        local c="${1:i:1}"
        case $c in
            [a-zA-Z0-9.~_-]) printf "$c" ;;
            *) printf '%%%02X' "'$c" ;;
        esac
done
}

ENCODED_PATH=$(urlencode "$PROJECT_PATH")

api_call GET "/task-management/team-progress?projectPath=${ENCODED_PATH}"
