#!/bin/bash
# Score a completed task's quality for per-agent quality tracking (#174)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.taskId // empty')
QUALITY_SCORE=$(printf '%s' "$INPUT" | jq -r '.qualityScore // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')

require_param "taskId" "$TASK_ID"
require_param "qualityScore" "$QUALITY_SCORE"

BODY=$(jq -n \
  --arg taskId "$TASK_ID" \
  --argjson qualityScore "$QUALITY_SCORE" \
  --arg scoredBy "${SESSION_NAME:-auditor}" \
  '{taskId: $taskId, qualityScore: $qualityScore, scoredBy: $scoredBy}')

api_call POST "/tasks/score" "$BODY"
