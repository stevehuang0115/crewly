#!/bin/bash
# Mark a task as complete with a summary of the work done
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"absoluteTaskPath\":\"/path/to/task\",\"sessionName\":\"dev-1\",\"summary\":\"Implemented feature X\",\"output\":{\"key\":\"value\"}}'"

ABSOLUTE_TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.absoluteTaskPath // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
SUMMARY=$(printf '%s' "$INPUT" | jq -r '.summary // empty')
SKIP_GATES=$(printf '%s' "$INPUT" | jq -r '.skipGates // empty')
OUTPUT_JSON=$(printf '%s' "$INPUT" | jq -c '.output // empty')
require_param "absoluteTaskPath" "$ABSOLUTE_TASK_PATH"
require_param "sessionName" "$SESSION_NAME"
require_param "summary" "$SUMMARY"

# Optional structured VerificationRequest fields (for hierarchical workflows)
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.taskId // empty')
ARTIFACTS=$(printf '%s' "$INPUT" | jq -c '.artifacts // empty')
TEST_RESULTS=$(printf '%s' "$INPUT" | jq -r '.testResults // empty')
USE_STRUCTURED=$(printf '%s' "$INPUT" | jq -r '.structured // "false"')

# If structured mode is enabled and taskId is provided, send a [VERIFICATION REQUEST]
# to the orchestrator/team-leader before completing the task file.
if [ "$USE_STRUCTURED" = "true" ] && [ -n "$TASK_ID" ]; then
  VER_MESSAGE="---\n[VERIFICATION REQUEST]\nTask ID: ${TASK_ID}\nRequested by: ${SESSION_NAME}\n---\n\n## Summary\n${SUMMARY}"

  # Add artifacts if provided
  if [ -n "$ARTIFACTS" ] && [ "$ARTIFACTS" != "" ]; then
    ARTIFACT_LINES=$(printf '%s' "$ARTIFACTS" | jq -r '.[]? | "- **\(.name)** (\(.type)): \(.content)"' 2>/dev/null || true)
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
      PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
      auto_remember "$SESSION_NAME" "Task completed by ${SESSION_NAME}: ${SUMMARY}" "pattern" "project" "$PROJECT_PATH"
    fi
    exit 0
  fi
fi

# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
# Resolve which V3 WorkItem to complete:
#   1. Explicit `workItemId` from input (preferred)
#   2. Fall back: query the pool for the agent's currently-running WI
#
# The legacy `absoluteTaskPath` input is still accepted but no longer
# drives the API call — it's only used for logging context. Callers
# should switch to passing `workItemId`.
WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // empty')
if [ -z "$WORK_ITEM_ID" ]; then
  POOL_RESP=$(api_call GET "/task-pool/items?status=running&target=${SESSION_NAME}" 2>/dev/null || echo '{}')
  WORK_ITEM_ID=$(echo "$POOL_RESP" | jq -r '.workItems[0].id // .data[0].id // empty' 2>/dev/null || true)
fi

if [ -z "$WORK_ITEM_ID" ]; then
  echo '{"error":"Could not resolve a running WorkItem for this session — pass `workItemId` explicitly."}' >&2
  exit 1
fi

# Hygiene #4: emit canonical body shape `{agentId, result:{summary, ...output}}`
# required by /api/task-pool/complete (task-pool.controller.ts `completeItem`).
# Prior shape `{summary, ..., result: $output}` 400'd because top-level summary
# was ignored (controller looks at result.summary) and `result` was overloaded
# with the output payload instead of the summary wrapper.
#
# The optional `output` is now MERGED into `result` alongside `summary` —
# this matches the controller's mergedOutput behavior (task-pool.controller.ts
# §405-419) which spreads result fields beyond `summary` into WorkItem.output.
#
# Precedence (per Sam #527 review note): jq's `+` operator is right-side-wins
# on key conflicts. The spread order here is `{summary: $summary} + $output`,
# so a caller-supplied `output.summary` WILL override the explicit `--summary`
# parameter. Intentional — callers passing structured output already have an
# authoritative summary in there; the explicit param is the fallback. If you
# need the param to win, swap the operands.
BODY=$(jq -n \
  --arg agentId "$SESSION_NAME" \
  --arg summary "$SUMMARY" \
  --arg skipGates "$SKIP_GATES" \
  --argjson output "${OUTPUT_JSON:-null}" \
  '{
    agentId: $agentId,
    result: ({summary: $summary}
              + (if $output != null and ($output | type) == "object"
                 then $output
                 else {} end))
  }
   + (if $skipGates == "true" then {skipGates: true} else {} end)')

api_call POST "/task-pool/complete/${WORK_ITEM_ID}" "$BODY"

# Auto-persist the task summary as project knowledge (#127, #219).
# Use [COMPLETED] prefix so recall can distinguish completed tasks from other patterns.
# This prevents PM from re-delegating tasks that were already done.
if [ -n "$SUMMARY" ]; then
  PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  auto_remember "$SESSION_NAME" "[COMPLETED] Task completed by ${SESSION_NAME}: ${SUMMARY}" "decision" "project" "$PROJECT_PATH"
fi
