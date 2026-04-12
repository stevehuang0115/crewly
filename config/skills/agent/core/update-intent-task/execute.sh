#!/bin/bash
# Update an intent task's status, assigned sessions, intent text, or other fields.
# Calls PUT /api/intent-tasks/:taskId with the provided update payload.
#
# Used by the orchestrator to manage its todo list:
# - pending → in_progress → completed/failed
# - Assign agents, update descriptions, etc.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh '{"taskId":"<id>","status":"in_progress"}'
  bash execute.sh '{"taskId":"<id>","status":"completed","result":"Deployed successfully"}'
  bash execute.sh '{"taskId":"<id>","assignedSessions":["dev-leo"]}'
  bash execute.sh '{"taskId":"<id>","intent":"Updated task description","category":"debugging"}'

Parameters:
  taskId           - Intent task ID (required)
  status           - New status: pending, classified, in_progress, paused, completed, failed, cancelled
  result           - Result summary (when completing/failing)
  intent           - Updated task description
  level            - Updated level: L0, L1, L2
  category         - Updated category: query, code_change, debugging, deployment, research, review, planning, communication, other
  assignedSessions - Array of agent session names to assign
  scheduleId       - Schedule ID to associate

Examples:
  # Start working on a task
  bash execute.sh '{"taskId":"abc-123","status":"in_progress","assignedSessions":["dev-leo"]}'

  # Complete a task
  bash execute.sh '{"taskId":"abc-123","status":"completed","result":"Bug fixed and deployed"}'

  # Fail a task
  bash execute.sh '{"taskId":"abc-123","status":"failed","result":"Build errors in TypeScript"}'
EOF_USAGE
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
if [ $# -eq 0 ] || [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
  print_usage
  exit 0
fi

JSON_INPUT=$(read_json_input "$1")

TASK_ID=$(echo "$JSON_INPUT" | jq -r '.taskId // empty')

if [ -z "$TASK_ID" ]; then
  echo '{"success":false,"error":"taskId is required"}'
  exit 1
fi

# Build the update body (exclude taskId — it goes in the URL)
BODY=$(echo "$JSON_INPUT" | jq 'del(.taskId)')

# Verify body has at least one field to update
FIELD_COUNT=$(echo "$BODY" | jq 'length')
if [ "$FIELD_COUNT" -eq 0 ]; then
  echo '{"success":false,"error":"At least one field to update is required (status, result, intent, level, category, assignedSessions)"}'
  exit 1
fi

# ---------------------------------------------------------------------------
# Call backend API
# ---------------------------------------------------------------------------
CREWLY_PORT="${CREWLY_PORT:-8787}"
API_URL="${CREWLY_API_URL:-http://localhost:${CREWLY_PORT}}"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X PUT \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${API_URL}/api/intent-tasks/${TASK_ID}" 2>&1) || {
  echo "{\"success\":false,\"error\":\"Failed to connect to backend at ${API_URL}\"}"
  exit 1
}

# Split response body and HTTP status code
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "$BODY_RESPONSE"
else
  echo "{\"success\":false,\"error\":\"HTTP ${HTTP_CODE}\",\"body\":$(echo "$BODY_RESPONSE" | jq -c '.' 2>/dev/null || echo "\"$BODY_RESPONSE\"")}"
  exit 1
fi
