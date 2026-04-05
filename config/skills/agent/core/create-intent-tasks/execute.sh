#!/bin/bash
# Create intent tasks from orchestrator LLM analysis of a user message.
# Calls POST /api/intent-tasks/batch with structured task data.
#
# The orchestrator analyzes the user's message, extracts actionable tasks,
# and calls this skill to persist them in the intent task system.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh '{"originalMessage":"user message","tasks":[{"intent":"task description","level":"L1","category":"code_change"}]}'

Parameters:
  originalMessage  - The original user message (required)
  tasks            - Array of task objects (required, at least 1)
    intent         - Clear task description in imperative form (required)
    level          - Complexity: "L0" (simple), "L1" (standard), "L2" (complex)
    category       - One of: query, code_change, debugging, deployment,
                     research, review, planning, communication, other

Example:
  bash execute.sh '{
    "originalMessage": "Fix the login bug and deploy to staging",
    "tasks": [
      {"intent": "Fix the login bug on the settings page", "level": "L1", "category": "debugging"},
      {"intent": "Deploy the fix to staging environment", "level": "L1", "category": "deployment"}
    ]
  }'
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

ORIGINAL_MESSAGE=$(echo "$JSON_INPUT" | jq -r '.originalMessage // empty')
TASKS=$(echo "$JSON_INPUT" | jq -c '.tasks // []')
TASK_COUNT=$(echo "$TASKS" | jq 'length')

if [ -z "$ORIGINAL_MESSAGE" ]; then
  echo '{"success":false,"error":"originalMessage is required"}'
  exit 1
fi

if [ "$TASK_COUNT" -eq 0 ]; then
  echo '{"success":false,"error":"tasks array must contain at least one task"}'
  exit 1
fi

# ---------------------------------------------------------------------------
# Build JSON body for batch create
# ---------------------------------------------------------------------------
BODY=$(jq -n \
  --arg msg "$ORIGINAL_MESSAGE" \
  --argjson tasks "$TASKS" \
  '{originalMessage: $msg, tasks: $tasks}')

# ---------------------------------------------------------------------------
# Call backend API
# ---------------------------------------------------------------------------
CREWLY_PORT="${CREWLY_PORT:-8787}"
API_URL="${CREWLY_API_URL:-http://localhost:${CREWLY_PORT}}"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${API_URL}/api/intent-tasks/batch" 2>&1) || {
  echo "{\"success\":false,\"error\":\"Failed to connect to backend at ${API_URL}\"}"
  exit 1
}

# Split response body and HTTP status code
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  # Extract task count from response for a clean summary
  CREATED_COUNT=$(echo "$BODY_RESPONSE" | jq '.data | length' 2>/dev/null || echo "$TASK_COUNT")
  echo "{\"success\":true,\"created\":${CREATED_COUNT},\"data\":$(echo "$BODY_RESPONSE" | jq -c '.data' 2>/dev/null || echo '[]')}"
else
  echo "{\"success\":false,\"error\":\"HTTP ${HTTP_CODE}\",\"body\":$(echo "$BODY_RESPONSE" | jq -c '.' 2>/dev/null || echo "\"$BODY_RESPONSE\"")}"
  exit 1
fi
