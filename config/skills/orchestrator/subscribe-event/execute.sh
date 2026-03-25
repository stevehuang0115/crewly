#!/bin/bash
# Subscribe to agent lifecycle events
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"eventType\":\"agent:idle\",\"filter\":{\"sessionName\":\"agent-joe\"},\"oneShot\":true}'"

EVENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.eventType // empty')
require_param "eventType" "$EVENT_TYPE"

# Inject subscriberSession from env (set by Crewly on each PTY session)
# The API requires subscriberSession and filter but the agent doesn't need to provide them
SUBSCRIBER_SESSION="${CREWLY_SESSION_NAME:-crewly-orc}"
BODY=$(printf '%s' "$INPUT" | jq --arg ss "$SUBSCRIBER_SESSION" \
  '. + {subscriberSession: $ss} | if .filter == null then .filter = {} else . end')

api_call POST "/events/subscribe" "$BODY"
