#!/bin/bash
# Transfer a Crewly App to another agent / team
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"appId\":\"vm4p556kuj\",\"toSession\":\"team-member-session\"}'"

APP=$(printf '%s' "$INPUT" | jq -r '.appId // empty')
TO=$(printf '%s' "$INPUT" | jq -r '.toSession // empty')
require_param "appId" "$APP"
require_param "toSession" "$TO"

BODY=$(jq -n --arg to "$TO" '{toSession: $to}')
api_call POST "/apps/${APP}/transfer" "$BODY"
