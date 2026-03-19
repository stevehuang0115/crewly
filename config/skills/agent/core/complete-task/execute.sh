#!/bin/bash
# Mark a task as complete with a summary of the work done
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"absoluteTaskPath\":\"/path/to/task\",\"sessionName\":\"dev-1\",\"summary\":\"Implemented feature X\",\"output\":{\"key\":\"value\"}}'"

ABSOLUTE_TASK_PATH=$(echo "$INPUT" | jq -r '.absoluteTaskPath // empty')
SESSION_NAME=$(echo "$INPUT" | jq -r '.sessionName // empty')
SUMMARY=$(echo "$INPUT" | jq -r '.summary // empty')
SKIP_GATES=$(echo "$INPUT" | jq -r '.skipGates // empty')
OUTPUT_JSON=$(echo "$INPUT" | jq -c '.output // empty')
require_param "absoluteTaskPath" "$ABSOLUTE_TASK_PATH"
require_param "sessionName" "$SESSION_NAME"
require_param "summary" "$SUMMARY"

# Optional structured VerificationRequest fields (for hierarchical workflows)
TASK_ID=$(echo "$INPUT" | jq -r '.taskId // empty')
ARTIFACTS=$(echo "$INPUT" | jq -c '.artifacts // empty')
TEST_RESULTS=$(echo "$INPUT" | jq -r '.testResults // empty')
USE_STRUCTURED=$(echo "$INPUT" | jq -r '.structured // "false"')

# If structured mode is enabled and taskId is provided, send a [VERIFICATION REQUEST]
# to the orchestrator/team-leader before completing the task file.
if [ "$USE_STRUCTURED" = "true" ] && [ -n "$TASK_ID" ]; then
  VER_MESSAGE="---\n[VERIFICATION REQUEST]\nTask ID: ${TASK_ID}\nRequested by: ${SESSION_NAME}\n---\n\n## Summary\n${SUMMARY}"

  # Add artifacts if provided
  if [ -n "$ARTIFACTS" ] && [ "$ARTIFACTS" != "" ]; then
    ARTIFACT_LINES=$(echo "$ARTIFACTS" | jq -r '.[]? | "- **\(.name)** (\(.type)): \(.content)"' 2>/dev/null || true)
    if [ -n "$ARTIFACT_LINES" ]; then
      VER_MESSAGE="${VER_MESSAGE}\n\n## Artifacts\n${ARTIFACT_LINES}"
    fi
  fi

  # Add test results if provided
  if [ -n "$TEST_RESULTS" ]; then
    VER_MESSAGE="${VER_MESSAGE}\n\n## Test Results\n${TEST_RESULTS}"
  fi

  # Send verification request to orchestrator via chat API
  VER_BODY=$(jq -n --arg content "$VER_MESSAGE" --arg senderName "$SESSION_NAME" \
    '{content: $content, senderName: $senderName, senderType: "agent"}')
  api_call POST "/chat/agent-response" "$VER_BODY" || true
fi

# #186: If the task file was already moved from in_progress/ to done/ by
# report-status (via complete-by-session), succeed silently instead of failing.
if echo "$ABSOLUTE_TASK_PATH" | grep -q '/in_progress/'; then
  DONE_PATH="${ABSOLUTE_TASK_PATH/\/in_progress\///done/}"
  if [ -f "$DONE_PATH" ] && [ ! -f "$ABSOLUTE_TASK_PATH" ]; then
    echo '{"success":true,"message":"Task already completed (moved to done by report-status)"}'
    # Still persist knowledge below, then exit
    if [ -n "$SUMMARY" ]; then
      PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
      auto_remember "$SESSION_NAME" "[COMPLETED] Task completed by ${SESSION_NAME}: ${SUMMARY}" "decision" "project" "$PROJECT_PATH"
    fi
    exit 0
  fi
fi

BODY=$(jq -n \
  --arg absoluteTaskPath "$ABSOLUTE_TASK_PATH" \
  --arg taskPath "$ABSOLUTE_TASK_PATH" \
  --arg sessionName "$SESSION_NAME" \
  --arg summary "$SUMMARY" \
  --arg skipGates "$SKIP_GATES" \
  --argjson output "${OUTPUT_JSON:-null}" \
  '{absoluteTaskPath: $absoluteTaskPath, taskPath: $taskPath, sessionName: $sessionName, summary: $summary} +
   (if $skipGates == "true" then {skipGates: true} else {} end) +
   (if $output != null then {output: $output} else {} end)')

api_call POST "/task-management/complete" "$BODY"

# Auto-persist the task summary as project knowledge (#127, #219).
# Use [COMPLETED] prefix so recall can distinguish completed tasks from other patterns.
# This prevents PM from re-delegating tasks that were already done.
if [ -n "$SUMMARY" ]; then
  PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
  auto_remember "$SESSION_NAME" "[COMPLETED] Task completed by ${SESSION_NAME}: ${SUMMARY}" "decision" "project" "$PROJECT_PATH"
fi
