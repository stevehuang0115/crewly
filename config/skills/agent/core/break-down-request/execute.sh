#!/bin/bash
# Break down a V3 Request into specific, actionable WorkItems in the TaskPool.
# Each task is added as a WorkItem, then linked back to the parent Request.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --request-id "req_abc123" --tasks '[{"title":"Task 1","description":"Do thing","type":"delegate"}]'

  # Using --file for complex JSON (avoids shell escaping issues)
  bash execute.sh --file /tmp/crewly_input.json

  # Legacy JSON (backward compatible)
  bash execute.sh '{"requestId":"req_abc123","tasks":[...]}'

Options:
  --request-id         | -r   The Request ID to decompose (required)
  --tasks                     JSON array of task objects (required)
  --json               | -j   Raw JSON payload (same as legacy)
  --help               | -h   Show this help

Task object fields:
  title        (required)  Concise task title
  description  (required)  Detailed instructions
  type         (required)  delegate | check | notify | review
  priority     (optional)  low | normal | high | urgent (default: normal)
  target       (optional)  Target agent session name or role
EOF_USAGE
}

INPUT_JSON=""
REQUEST_ID=""
TASKS_JSON=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --request-id|-r)
      REQUEST_ID="$2"
      shift 2
      ;;
    --tasks)
      TASKS_JSON="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"
        shift
      else
        error_exit "Unknown argument: $1. Use --help for usage."
      fi
      ;;
  esac
done

# Read from stdin if no input yet
if [ -z "$INPUT_JSON" ] && [ -z "$REQUEST_ID" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$REQUEST_ID" ] && REQUEST_ID=$(printf '%s' "$INPUT" | jq -r '.requestId // empty')
  [ -z "$TASKS_JSON" ] && TASKS_JSON=$(printf '%s' "$INPUT" | jq -c '.tasks // empty')
fi

# Validate required parameters
require_param "request-id (--request-id)" "$REQUEST_ID"
require_param "tasks (--tasks)" "$TASKS_JSON"

# Validate tasks is a JSON array
TASK_COUNT=$(printf '%s' "$TASKS_JSON" | jq 'length' 2>/dev/null || echo "0")
if [ "$TASK_COUNT" = "0" ]; then
  error_exit "tasks must be a non-empty JSON array of task objects"
fi

# Validate each task has required fields
for i in $(seq 0 $((TASK_COUNT - 1))); do
  TASK_TITLE=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].title // empty")
  TASK_DESC=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].description // empty")
  TASK_TYPE=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].type // empty")

  if [ -z "$TASK_TITLE" ]; then
    error_exit "Task at index $i is missing required field: title"
  fi
  if [ -z "$TASK_DESC" ]; then
    error_exit "Task at index $i is missing required field: description"
  fi
  if [ -z "$TASK_TYPE" ]; then
    error_exit "Task at index $i is missing required field: type"
  fi

  # Validate type
  case "$TASK_TYPE" in
    delegate|check|notify|review) ;;
    *) error_exit "Task at index $i has invalid type: $TASK_TYPE. Must be one of: delegate, check, notify, review." ;;
  esac
done

# Create WorkItems for each task
WORK_ITEM_IDS="[]"
CREATED=0
FAILED=0

for i in $(seq 0 $((TASK_COUNT - 1))); do
  TASK_TITLE=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].title")
  TASK_DESC=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].description")
  TASK_TYPE=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].type")
  TASK_PRIORITY=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].priority // \"normal\"")
  TASK_TARGET=$(printf '%s' "$TASKS_JSON" | jq -r ".[$i].target // \"unassigned\"")

  # Generate a unique ID for the WorkItem
  WORK_ITEM_ID="wi_$(date +%s%N | cut -c1-13)_${i}"

  # Build WorkItem body matching the expected format for POST /task-pool/add
  WI_BODY=$(jq -n \
    --arg id "$WORK_ITEM_ID" \
    --arg type "$TASK_TYPE" \
    --arg owner "orchestrator" \
    --arg target "$TASK_TARGET" \
    --arg title "$TASK_TITLE" \
    --arg description "$TASK_DESC" \
    --arg status "queued" \
    --arg requestId "$REQUEST_ID" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{
      id: $id,
      type: $type,
      owner: $owner,
      target: $target,
      title: $title,
      description: $description,
      status: $status,
      requestId: $requestId,
      createdAt: $createdAt,
      retryCount: 0,
      maxRetries: 3,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    }')

  # Add to the task pool
  if RESULT=$(api_call POST "/task-pool/add" "$WI_BODY" 2>&1); then
    WORK_ITEM_IDS=$(printf '%s' "$WORK_ITEM_IDS" | jq --arg wid "$WORK_ITEM_ID" '. + [$wid]')
    CREATED=$((CREATED + 1))
  else
    echo "[warn] Failed to create WorkItem for task '$TASK_TITLE': $RESULT" >&2
    FAILED=$((FAILED + 1))
  fi
done

# Link all created WorkItem IDs to the parent Request
if [ "$CREATED" -gt 0 ]; then
  LINK_BODY=$(printf '%s' "$WORK_ITEM_IDS" | jq '{workItemIds: .}')
  api_call PUT "/requests/$REQUEST_ID" "$LINK_BODY" >/dev/null 2>&1 || \
    echo "[warn] Failed to link WorkItems to Request $REQUEST_ID (non-fatal)" >&2
fi

# Output summary
jq -n \
  --arg requestId "$REQUEST_ID" \
  --argjson workItemIds "$WORK_ITEM_IDS" \
  --argjson created "$CREATED" \
  --argjson failed "$FAILED" \
  --argjson total "$TASK_COUNT" \
  '{
    success: true,
    requestId: $requestId,
    workItemIds: $workItemIds,
    count: $created,
    failed: $failed,
    total: $total
  }'
