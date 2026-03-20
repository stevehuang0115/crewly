#!/bin/bash
# Update a cron task (change schedule, description, or enable/disable)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"id\":\"cron-xxx\",\"taskDescription\":\"Updated task\"}'"

ID=$(echo "$INPUT" | jq -r '.id // empty')
require_param "id" "$ID"

# Build body with only provided fields
BODY=$(echo "$INPUT" | jq 'del(.id)')

api_call PATCH "/cron-tasks/${ID}" "$BODY"
