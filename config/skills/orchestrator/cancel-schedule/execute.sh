#!/bin/bash
# Cancel a scheduled check by ID
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"scheduleId\":\"sched-123\"}'"

SCHEDULE_ID=$(printf '%s' "$INPUT" | jq -r '.scheduleId // empty')
require_param "scheduleId" "$SCHEDULE_ID"

api_call DELETE "/schedule/${SCHEDULE_ID}"
