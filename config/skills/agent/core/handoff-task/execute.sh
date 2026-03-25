#!/bin/bash
# =============================================================================
# Multi-Agent Task Handoff (F12)
#
# Transfers an in-progress task from the current agent (Agent A) to another
# agent (Agent B). Unlike delegate-task which assigns NEW work, handoff
# transfers ONGOING work with full context (progress, findings, blockers).
#
# Flow:
#   1. Agent A calls handoff-task with target agent + task context
#   2. Backend creates a handoff record linking original task to new assignee
#   3. Target agent receives the task with full A→B context
#   4. Original agent's task is marked as 'handed_off' (not completed)
#
# Usage:
#   execute.sh '{"to":"agent-b-session","taskPath":"/path/to/task.md",
#     "reason":"Blocked on infra, B has access","progress":"70% done...",
#     "projectPath":"/path/to/project"}'
#
# @see F12: Multi-Agent Task Handoff
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"to\":\"target-session\",\"taskPath\":\"/path/to/task.md\",\"reason\":\"...\",\"progress\":\"...\"}'"

TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.taskPath // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // "Task handoff"')
PROGRESS=$(printf '%s' "$INPUT" | jq -r '.progress // empty')
FINDINGS=$(printf '%s' "$INPUT" | jq -r '.findings // empty')
BLOCKERS=$(printf '%s' "$INPUT" | jq -r '.blockers // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
FROM_SESSION="${CREWLY_SESSION_NAME:-unknown}"

require_param "to" "$TO"
require_param "reason" "$REASON"

# Resolve Crewly root
CREWLY_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# Build handoff context message
HANDOFF_MESSAGE="[TASK HANDOFF] from ${FROM_SESSION}

## Reason for Handoff
${REASON}
"

if [ -n "$PROGRESS" ]; then
  HANDOFF_MESSAGE="${HANDOFF_MESSAGE}
## Current Progress
${PROGRESS}
"
fi

if [ -n "$FINDINGS" ]; then
  HANDOFF_MESSAGE="${HANDOFF_MESSAGE}
## Key Findings
${FINDINGS}
"
fi

if [ -n "$BLOCKERS" ]; then
  HANDOFF_MESSAGE="${HANDOFF_MESSAGE}
## Blockers / Notes
${BLOCKERS}
"
fi

if [ -n "$TASK_PATH" ]; then
  HANDOFF_MESSAGE="${HANDOFF_MESSAGE}
## Task File
${TASK_PATH}
"
  # Read task content if file exists
  if [ -f "$TASK_PATH" ]; then
    TASK_CONTENT=$(head -100 "$TASK_PATH" 2>/dev/null || true)
    HANDOFF_MESSAGE="${HANDOFF_MESSAGE}
## Original Task Content
\`\`\`
${TASK_CONTENT}
\`\`\`
"
  fi
fi

HANDOFF_MESSAGE="${HANDOFF_MESSAGE}
---
When done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\",\"projectPath\":\"${PROJECT_PATH}\"}'"

# Step 1: Deliver handoff message to target agent
DELIVER_BODY=$(jq -n \
  --arg message "$HANDOFF_MESSAGE" \
  '{message: $message, waitForReady: true, waitTimeout: 15000}')

echo "Delivering handoff to ${TO}..." >&2
deliver_result=$(api_call POST "/terminal/${TO}/deliver" "$DELIVER_BODY" 2>/dev/null) || {
  # Retry with force delivery
  DELIVER_BODY=$(jq -n \
    --arg message "$HANDOFF_MESSAGE" \
    '{message: $message, force: true}')
  deliver_result=$(api_call POST "/terminal/${TO}/deliver" "$DELIVER_BODY" 2>/dev/null) || deliver_result='{"error":"delivery failed"}'
}

# Step 2: Update original task status to handed_off (if task path provided)
if [ -n "$TASK_PATH" ] && [ -f "$TASK_PATH" ]; then
  # Append handoff metadata to task file
  cat >> "$TASK_PATH" << HANDOFF_EOF

## Handoff Record
- **Handed off to**: ${TO}
- **Handed off from**: ${FROM_SESSION}
- **Reason**: ${REASON}
- **Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
HANDOFF_EOF
fi

# Step 3: Create handoff tracking via task management API
HANDOFF_BODY=$(jq -n \
  --arg from "$FROM_SESSION" \
  --arg to "$TO" \
  --arg taskPath "${TASK_PATH:-}" \
  --arg reason "$REASON" \
  --arg progress "${PROGRESS:-}" \
  --arg projectPath "${PROJECT_PATH:-}" \
  '{from: $from, to: $to, taskPath: $taskPath, reason: $reason, progress: $progress, projectPath: $projectPath}')

# Try to record the handoff (non-fatal if endpoint doesn't exist yet)
handoff_result=$(api_call POST "/task-management/handoff" "$HANDOFF_BODY" 2>/dev/null) || handoff_result='{"tracked":false}'

cat <<EOF
{
  "success": true,
  "handoff": {
    "from": "${FROM_SESSION}",
    "to": "${TO}",
    "reason": "${REASON}",
    "taskPath": "${TASK_PATH:-null}",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  },
  "delivery": ${deliver_result},
  "tracking": ${handoff_result}
}
EOF

# Auto-persist handoff as project knowledge
auto_remember "$FROM_SESSION" "Task handoff from ${FROM_SESSION} to ${TO}: ${REASON}" "fact" "project" "$PROJECT_PATH"
