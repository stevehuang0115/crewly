#!/bin/bash
# Cancel an event subscription
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"subscriptionId\":\"sub-123\"}'"

SUB_ID=$(printf '%s' "$INPUT" | jq -r '.subscriptionId // empty')
require_param "subscriptionId" "$SUB_ID"

api_call DELETE "/events/subscribe/${SUB_ID}"
