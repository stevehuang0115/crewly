#!/bin/bash
# Decompose a user message into multiple intent tasks via the backend API.
# Calls POST /api/intent-tasks/decompose and outputs JSON result.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --message "Search for abc then make it into a PDF"
  bash execute.sh --message "Do X and Y" --auto-schedule false
  bash execute.sh --message "Task text" --project-task-id "task-123" --tags "urgent,backend"

  # Legacy JSON argument (backward compatible)
  bash execute.sh '{"message":"Search for abc","autoSchedule":true}'

Options:
  --message       | -m   User message to decompose (required)
  --auto-schedule | -a   Auto-create follow-up schedules (default: true)
  --project-task-id      Associated project task ID (optional)
  --tags          | -t   Comma-separated tags (optional)
EOF_USAGE
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
MESSAGE=""
AUTO_SCHEDULE="true"
PROJECT_TASK_ID=""
TAGS=""

if [ $# -eq 0 ]; then
  print_usage
  exit 1
fi

# Check if first arg looks like JSON
if [[ "${1:-}" == "{"* ]]; then
  JSON_INPUT=$(read_json_input "$1")
  MESSAGE=$(echo "$JSON_INPUT" | jq -r '.message // empty')
  AUTO_SCHEDULE=$(echo "$JSON_INPUT" | jq -r '.autoSchedule // "true"')
  PROJECT_TASK_ID=$(echo "$JSON_INPUT" | jq -r '.projectTaskId // empty')
  TAGS=$(echo "$JSON_INPUT" | jq -r '(.tags // []) | if type == "array" then join(",") else . end')
else
  while [ $# -gt 0 ]; do
    case "$1" in
      --message|-m)    MESSAGE="$2"; shift 2 ;;
      --auto-schedule|-a) AUTO_SCHEDULE="$2"; shift 2 ;;
      --project-task-id)  PROJECT_TASK_ID="$2"; shift 2 ;;
      --tags|-t)       TAGS="$2"; shift 2 ;;
      --help|-h)       print_usage; exit 0 ;;
      *)               echo "{\"error\":\"Unknown option: $1\"}"; exit 1 ;;
    esac
  done
fi

if [ -z "$MESSAGE" ]; then
  echo '{"error":"message is required"}'
  exit 1
fi

# ---------------------------------------------------------------------------
# Build JSON body
# ---------------------------------------------------------------------------
BODY=$(jq -n \
  --arg message "$MESSAGE" \
  --argjson autoSchedule "${AUTO_SCHEDULE}" \
  '{message: $message, autoSchedule: $autoSchedule}')

if [ -n "$PROJECT_TASK_ID" ]; then
  BODY=$(echo "$BODY" | jq --arg pid "$PROJECT_TASK_ID" '. + {projectTaskId: $pid}')
fi

if [ -n "$TAGS" ]; then
  BODY=$(echo "$BODY" | jq --arg tags "$TAGS" '. + {tags: ($tags | split(",") | map(select(. != "")))}')
fi

# ---------------------------------------------------------------------------
# Call backend API
# ---------------------------------------------------------------------------
CREWLY_PORT="${CREWLY_PORT:-8787}"
API_URL="${CREWLY_API_URL:-http://localhost:${CREWLY_PORT}}"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${API_URL}/api/intent-tasks/decompose" 2>&1) || {
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
