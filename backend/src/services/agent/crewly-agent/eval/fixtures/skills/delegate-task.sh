#!/bin/bash
# Eval skill shim: delegate-task
#
# Assigns a task to a team member. Writes a delegation record
# to .crewly/tasks/ for the eval framework to verify.
#
# Usage:
#   bash skills/delegate-task.sh '{"to":"eval-dev-leo","task":"implement feature","priority":"high"}'
#
# Output: JSON with taskId and delegatedTo

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_log.sh"

INPUT="${1:-'{}'}"
log_tool_call "delegate-task" "$INPUT"

TO=$(echo "$INPUT" | jq -r '.to // "unknown"')
TASK=$(echo "$INPUT" | jq -r '.task // "unspecified"')
PRIORITY=$(echo "$INPUT" | jq -r '.priority // "medium"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TASK_ID="task-$(date +%s)-$$"

mkdir -p .crewly/tasks

cat > ".crewly/tasks/${TASK_ID}-delegation.json" <<EOF
{
  "taskId": "$TASK_ID",
  "delegatedTo": "$TO",
  "task": $(echo "$TASK" | jq -Rs .),
  "priority": "$PRIORITY",
  "delegatedAt": "$TIMESTAMP",
  "delegatedBy": "eval-tl-sam"
}
EOF

echo "{\"success\":true,\"taskId\":\"$TASK_ID\",\"delegatedTo\":\"$TO\"}"
