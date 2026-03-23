#!/bin/bash
# =============================================================================
# Agent Heartbeat Skill - Lightweight health check and heartbeat update
#
# Calls the /health endpoint to update the agent heartbeat via the
# X-Agent-Session middleware header (set automatically by lib.sh).
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_common/lib.sh"

# Single API call updates heartbeat via the X-Agent-Session middleware.
# Use curl directly instead of api_call so we capture the response body
# even on non-2xx status codes (e.g. 503 unhealthy). api_call returns 1
# for non-2xx, losing the actual status (#259).
health_response=$(curl -s -X GET "${CREWLY_API_URL}/api/health" \
  -H "Content-Type: application/json" \
  ${CREWLY_SESSION_NAME:+-H "X-Agent-Session: $CREWLY_SESSION_NAME"} \
  2>/dev/null) || health_response='{"error":"unavailable"}'

# Validate that response is valid JSON; fall back if not
if ! echo "$health_response" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  health_response='{"error":"invalid_response"}'
fi

# Extract actual health status from response, default to "ok" if unavailable
actual_status=$(echo "$health_response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('status', 'ok'))
except:
    print('unavailable')
" 2>/dev/null || echo "ok")

cat <<EOF
{
  "status": "$actual_status",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "session": "${CREWLY_SESSION_NAME:-unknown}",
  "health": $health_response
}
EOF
