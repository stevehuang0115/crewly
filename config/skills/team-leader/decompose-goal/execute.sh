#!/bin/bash
# Decompose a high-level objective into worker-level sub-tasks.
# Creates task files in the project's .crewly/tasks/ directory via task-management API.
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

  # Build task description with acceptance criteria
  FULL_DESC="${TASK_DESC}"
  [ -n "$TASK_CRITERIA" ] && FULL_DESC="${FULL_DESC}\n\n## Acceptance Criteria\n${TASK_CRITERIA}"
  FULL_DESC="${FULL_DESC}\n\n## Context\nParent objective: ${OBJECTIVE}\nRequired role: ${TASK_ROLE}"

  CREATE_BODY=$(jq -n \
    --arg projectPath "${PROJECT_PATH}" \
    --arg task "$FULL_DESC" \
    --arg priority "$TASK_PRIORITY" \
    --arg milestone "$MILESTONE" \
    --arg title "$TASK_TITLE" \
    '{projectPath: $projectPath, task: $task, priority: $priority, milestone: $milestone, title: $title}')

  CREATE_RESULT=$(api_call POST "/task-management/create" "$CREATE_BODY" 2>/dev/null || echo '{"error":"Failed to create task"}')
  TASK_PATH=$(echo "$CREATE_RESULT" | jq -r '.taskPath // empty' 2>/dev/null || true)
  TASK_ID=$(echo "$CREATE_RESULT" | jq -r '.taskId // empty' 2>/dev/null || true)

  if [ -n "$TASK_PATH" ]; then
    CREATED_TASKS=$(echo "$CREATED_TASKS" | jq \
      --arg title "$TASK_TITLE" \
      --arg role "$TASK_ROLE" \
      --arg path "$TASK_PATH" \
      --arg id "$TASK_ID" \
      --arg priority "$TASK_PRIORITY" \
      '. + [{title: $title, requiredRole: $role, taskPath: $path, taskId: $id, priority: $priority}]')
  else
    ERRORS=$(echo "$ERRORS" | jq --arg msg "Failed to create task: ${TASK_TITLE}" '. + [$msg]')
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
