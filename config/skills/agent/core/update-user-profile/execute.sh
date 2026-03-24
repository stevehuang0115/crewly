#!/bin/bash
# Update the shared user profile — preferences visible to ALL agents
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"updatedBy\":\"crewly-orc\",\"language\":\"zh-CN\",\"reportingStyle\":\"detailed\"}'"

UPDATED_BY=$(echo "$INPUT" | jq -r '.updatedBy // empty')
require_param "updatedBy" "$UPDATED_BY"

api_call POST "/memory/user-profile" "$INPUT"
