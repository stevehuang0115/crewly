#!/bin/bash
# =============================================================================
# Heartbeat Skill - System health check and heartbeat update
#
# Calls multiple API endpoints to:
# 1. Update the orchestrator heartbeat via the X-Agent-Session middleware
# 2. Return system status for situational awareness
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_common/lib.sh"

# Collect status from multiple endpoints (each call updates heartbeat via middleware)
teams_response=$(api_call GET "/teams" 2>/dev/null) || teams_response='{"error":"unavailable"}'
projects_response=$(api_call GET "/projects" 2>/dev/null) || projects_response='{"error":"unavailable"}'
queue_response=$(api_call GET "/messaging/queue/status" 2>/dev/null) || queue_response='{"error":"unavailable"}'

# Parse helpers:
# - strict=False tolerates embedded control chars (e.g. raw \n in agent system-prompt strings)
# - All three endpoints wrap payload as {success, data}; drill into .data, falling back to the
#   raw dict for older shapes.
# - On parse failure / missing field, emit valid JSON (null or 0) — never an unquoted '?'.

count_data() {
    # Count elements in the .data array (or fall back to the raw response).
    python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read(), strict=False)
except Exception:
    print(0); sys.exit(0)
payload = d.get('data', d) if isinstance(d, dict) else d
print(len(payload) if isinstance(payload, (list, dict)) else 0)
" 2>/dev/null || echo 0
}

team_count=$(echo "$teams_response" | count_data)
project_count=$(echo "$projects_response" | count_data)

# Queue: pendingCount (int) and isProcessing (bool, mapped to 0/1).
queue_pending=$(echo "$queue_response" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read(), strict=False)
    payload = d.get('data', d) if isinstance(d, dict) else d
    v = payload.get('pendingCount', payload.get('pending', 0)) if isinstance(payload, dict) else 0
    print(int(v) if v is not None else 0)
except Exception:
    print(0)
" 2>/dev/null || echo 0)

queue_processing=$(echo "$queue_response" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read(), strict=False)
    payload = d.get('data', d) if isinstance(d, dict) else d
    if isinstance(payload, dict):
        v = payload.get('processingCount')
        if v is None:
            v = 1 if payload.get('isProcessing') else 0
        print(int(v))
    else:
        print(0)
except Exception:
    print(0)
" 2>/dev/null || echo 0)

cat <<EOF
{
  "status": "ok",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "summary": {
    "teams": $team_count,
    "projects": $project_count,
    "queuePending": $queue_pending,
    "queueProcessing": $queue_processing
  }
}
EOF
