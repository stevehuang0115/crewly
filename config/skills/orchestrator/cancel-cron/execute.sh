#!/bin/bash
# Cancel (delete) a cron task — user/orchestrator only
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"id\":\"cron-xxx\"}'"

ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
require_param "id" "$ID"

api_call DELETE "/cron-tasks/${ID}"
