#!/bin/bash
# Decompose a high-level objective into worker-level WorkItems.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Each
# sub-task becomes a V3 WorkItem in the task-pool via `POST /task-pool/add`.
# The legacy v1 `/task-management/create` endpoint that wrote `.md` files
# is gone.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"objective\":\"Build auth module\",\"projectPath\":\"/path/to/project\",\"tasks\":[{\"title\":\"...\",\"description\":\"...\",\"requiredRole\":\"developer\",\"acceptanceCriteria\":\"...\",\"priority\":\"high\"}]}'"

OBJECTIVE=$(printf '%s' "$INPUT" | jq -r '.objective // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
TASKS=$(printf '%s' "$INPUT" | jq -c '.tasks // empty')
MILESTONE=$(printf '%s' "$INPUT" | jq -r '.milestone // "delegated"')
require_param "objective" "$OBJECTIVE"
require_param "tasks" "$TASKS"

# Validate tasks array is non-empty
TASK_COUNT=$(echo "$TASKS" | jq 'length')
if [ "$TASK_COUNT" = "0" ]; then
  error_exit "tasks array must contain at least one task"
fi

CREATED_TASKS="[]"
ERRORS="[]"

# Create each sub-task via the task-management API
for i in $(seq 0 $((TASK_COUNT - 1))); do
  TASK_TITLE=$(echo "$TASKS" | jq -r ".[$i].title // empty")
  TASK_DESC=$(echo "$TASKS" | jq -r ".[$i].description // empty")
  TASK_ROLE=$(echo "$TASKS" | jq -r ".[$i].requiredRole // \"developer\"")
  TASK_CRITERIA=$(echo "$TASKS" | jq -r ".[$i].acceptanceCriteria // empty")
  TASK_PRIORITY=$(echo "$TASKS" | jq -r ".[$i].priority // \"normal\"")

  if [ -z "$TASK_TITLE" ] || [ -z "$TASK_DESC" ]; then
    ERRORS=$(echo "$ERRORS" | jq --arg idx "$i" --arg msg "Task $i missing title or description" '. + [$msg]')
    continue
  fi

  # Compose the brief markdown for the WorkItem.
  BRIEF="${TASK_DESC}"
  [ -n "$TASK_CRITERIA" ] && BRIEF="${BRIEF}

## Acceptance Criteria
${TASK_CRITERIA}"
  BRIEF="${BRIEF}

## Context
Parent objective: ${OBJECTIVE}
Required role: ${TASK_ROLE}"

  case "$TASK_PRIORITY" in
    critical) PRIORITY_NUM=1 ;;
    high)     PRIORITY_NUM=2 ;;
    normal|medium) PRIORITY_NUM=3 ;;
    low)      PRIORITY_NUM=4 ;;
    *)        PRIORITY_NUM=3 ;;
  esac

  WI_ID="task-$(date +%s%N | cut -c1-13)-${i}-$$"

  WORK_ITEM=$(jq -n \
    --arg id "$WI_ID" \
    --arg title "$TASK_TITLE" \
    --arg brief "$BRIEF" \
    --arg projectPath "$PROJECT_PATH" \
    --arg milestone "$MILESTONE" \
    --arg role "$TASK_ROLE" \
    --argjson priority "$PRIORITY_NUM" \
    '{
      id: $id,
      title: $title,
      type: "delegate",
      owner: "system",
      priority: $priority,
      status: "queued",
      briefMarkdown: $brief,
      metadata: { projectPath: $projectPath, milestone: $milestone, requiredRole: $role }
    }')

  CREATE_BODY=$(jq -n --argjson workItem "$WORK_ITEM" '{workItem: $workItem}')
  CREATE_RESULT=$(api_call POST "/task-pool/add" "$CREATE_BODY" 2>/dev/null || echo '{"error":"Failed to create WorkItem"}')
  CREATED_ID=$(echo "$CREATE_RESULT" | jq -r '.data.id // .workItem.id // empty' 2>/dev/null || true)

  if [ -n "$CREATED_ID" ]; then
    CREATED_TASKS=$(echo "$CREATED_TASKS" | jq \
      --arg title "$TASK_TITLE" \
      --arg role "$TASK_ROLE" \
      --arg id "$CREATED_ID" \
      --arg priority "$TASK_PRIORITY" \
      '. + [{title: $title, requiredRole: $role, workItemId: $id, priority: $priority}]')
  else
    ERRORS=$(echo "$ERRORS" | jq --arg msg "Failed to create WorkItem: ${TASK_TITLE}" '. + [$msg]')
  fi
done

# Output result
CREATED_COUNT=$(echo "$CREATED_TASKS" | jq 'length')
ERROR_COUNT=$(echo "$ERRORS" | jq 'length')

jq -n \
  --arg objective "$OBJECTIVE" \
  --argjson tasks "$CREATED_TASKS" \
  --argjson errors "$ERRORS" \
  --arg totalCreated "$CREATED_COUNT" \
  --arg totalErrors "$ERROR_COUNT" \
  '{
    success: (($totalErrors | tonumber) == 0),
    objective: $objective,
    tasksCreated: ($totalCreated | tonumber),
    tasks: $tasks,
    errors: $errors
  }'
