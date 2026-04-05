#!/bin/bash
# =============================================================================
# Multi-Agent Task Handoff (F12)
#
# Transfers an in-progress task from the current agent to another agent.
# Unlike delegate-task (assigns NEW work), handoff transfers ONGOING work
# with full context — progress, findings, and blockers.
#
# Flow:
#   1. Validate inputs (from, to, reason)
#   2. Record handoff in backend task-management API (reassigns task)
#   3. Append handoff metadata to task file (if provided)
#   4. Deliver context message to target agent
#   5. Notify orchestrator/TL about the handoff
#   6. Persist handoff as project knowledge
#
# Usage:
#   bash execute.sh '{"sessionName":"agent-a","to":"agent-b",
#     "taskPath":"/path/to/task.md","reason":"Blocked on infra access",
#     "progress":"70% — API routes done, tests pending",
#     "findings":"Discovered shared util needed",
#     "blockers":"Need VPN credentials",
#     "projectPath":"/path/to/project"}'
#
# @see F12: Multi-Agent Task Handoff
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"from-agent\",\"to\":\"target-session\",\"reason\":\"...\",\"progress\":\"...\"}'"

# --- Parse parameters ---
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.taskPath // .absoluteTaskPath // empty')
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // "Task handoff"')
PROGRESS=$(printf '%s' "$INPUT" | jq -r '.progress // empty')
FINDINGS=$(printf '%s' "$INPUT" | jq -r '.findings // empty')
BLOCKERS=$(printf '%s' "$INPUT" | jq -r '.blockers // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

# Fall back to env var if sessionName not provided (backward compat)
[ -z "$SESSION_NAME" ] && SESSION_NAME="${CREWLY_SESSION_NAME:-}"

require_param "sessionName" "$SESSION_NAME"
require_param "to" "$TO"
require_param "reason" "$REASON"

# Resolve Crewly root for report-status path in handoff message
CREWLY_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- Step 0: Fission guard check (rate limit before handoff) ---
# Non-blocking: if the fission API is unavailable, proceed with handoff.
FISSION_BODY=$(jq -n \
  --arg parentWorkItemId "${TASK_PATH:-handoff-stub}" \
  --arg agentId "$SESSION_NAME" \
  '{parentWorkItemId: $parentWorkItemId, agentId: $agentId}')

fission_result=$(api_call POST "/fission/check" "$FISSION_BODY" 2>/dev/null) || fission_result='{"success":false}'
fission_allowed=$(echo "$fission_result" | jq -r '.data.allowed // "true"')

if [ "$fission_allowed" = "false" ]; then
  fission_reason=$(echo "$fission_result" | jq -r '.data.reason // "Fission guard blocked this handoff"')
  echo "{\"success\":false,\"error\":\"Fission guard: ${fission_reason}\"}"
  exit 1
fi

# --- Step 1: Record handoff in backend (reassigns task on the task board) ---
HANDOFF_BODY=$(jq -n \
  --arg from "$SESSION_NAME" \
  --arg to "$TO" \
  --arg taskPath "${TASK_PATH:-}" \
  --arg reason "$REASON" \
  --arg progress "${PROGRESS:-}" \
  --arg projectPath "${PROJECT_PATH:-}" \
  '{from: $from, to: $to, taskPath: $taskPath, reason: $reason, progress: $progress, projectPath: $projectPath}')

echo "Recording handoff ${SESSION_NAME} → ${TO}..." >&2
handoff_result=$(api_call POST "/task-management/handoff" "$HANDOFF_BODY" 2>/dev/null) || handoff_result='{"tracked":false,"error":"handoff API unavailable"}'

# --- Step 2: Append handoff metadata to task file (if provided and exists) ---
if [ -n "$TASK_PATH" ] && [ -f "$TASK_PATH" ]; then
  cat >> "$TASK_PATH" << HANDOFF_EOF

## Handoff Record
- **Handed off to**: ${TO}
- **Handed off from**: ${SESSION_NAME}
- **Reason**: ${REASON}
- **Timestamp**: ${TIMESTAMP}
HANDOFF_EOF

  # Append progress/findings/blockers if provided
  if [ -n "$PROGRESS" ]; then
    printf '\n### Progress at Handoff\n%s\n' "$PROGRESS" >> "$TASK_PATH"
  fi
  if [ -n "$FINDINGS" ]; then
    printf '\n### Key Findings\n%s\n' "$FINDINGS" >> "$TASK_PATH"
  fi
  if [ -n "$BLOCKERS" ]; then
    printf '\n### Blockers\n%s\n' "$BLOCKERS" >> "$TASK_PATH"
  fi
fi

# --- Step 3: Build and deliver context message to target agent ---
# Use a temp file for the message to avoid shell escaping issues with jq
HANDOFF_MSG_FILE=$(mktemp)
trap 'rm -f "$HANDOFF_MSG_FILE"' EXIT

cat > "$HANDOFF_MSG_FILE" << MSG_EOF
[TASK HANDOFF] from ${SESSION_NAME}

## Reason for Handoff
${REASON}
MSG_EOF

if [ -n "$PROGRESS" ]; then
  printf '\n## Current Progress\n%s\n' "$PROGRESS" >> "$HANDOFF_MSG_FILE"
fi

if [ -n "$FINDINGS" ]; then
  printf '\n## Key Findings\n%s\n' "$FINDINGS" >> "$HANDOFF_MSG_FILE"
fi

if [ -n "$BLOCKERS" ]; then
  printf '\n## Blockers / Notes\n%s\n' "$BLOCKERS" >> "$HANDOFF_MSG_FILE"
fi

if [ -n "$TASK_PATH" ]; then
  printf '\n## Task File\n%s\n' "$TASK_PATH" >> "$HANDOFF_MSG_FILE"
  # Include task content if file exists (first 100 lines)
  if [ -f "$TASK_PATH" ]; then
    printf '\n## Original Task Content\n```\n' >> "$HANDOFF_MSG_FILE"
    head -100 "$TASK_PATH" >> "$HANDOFF_MSG_FILE" 2>/dev/null || true
    printf '\n```\n' >> "$HANDOFF_MSG_FILE"
  fi
fi

cat >> "$HANDOFF_MSG_FILE" << FOOTER_EOF

---
When done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{"sessionName":"${TO}","status":"done","summary":"<brief summary>","projectPath":"${PROJECT_PATH}"}'
FOOTER_EOF

HANDOFF_MESSAGE=$(cat "$HANDOFF_MSG_FILE")

# Deliver to target agent via terminal write API
DELIVER_BODY=$(jq -n --arg data "$HANDOFF_MESSAGE" --arg mode "message" \
  '{data: $data, mode: $mode}')

echo "Delivering handoff context to ${TO}..." >&2
deliver_result=$(api_call POST "/terminal/${TO}/write" "$DELIVER_BODY" 2>/dev/null) || {
  # Retry with deliver endpoint (agent may need wake-up)
  DELIVER_BODY_V2=$(jq -n --arg message "$HANDOFF_MESSAGE" \
    '{message: $message, waitForReady: true, waitTimeout: 15000}')
  deliver_result=$(api_call POST "/terminal/${TO}/deliver" "$DELIVER_BODY_V2" 2>/dev/null) || {
    deliver_result='{"error":"delivery failed — target agent may be offline"}'
    echo "Warning: could not deliver handoff to ${TO}" >&2
  }
}

# --- Step 4: Notify orchestrator/TL about the handoff ---
NOTIFY_MSG="[HANDOFF] ${SESSION_NAME} → ${TO}: ${REASON}"
NOTIFY_BODY=$(jq -n --arg content "$NOTIFY_MSG" --arg senderName "$SESSION_NAME" \
  '{content: $content, senderName: $senderName, senderType: "agent"}')
api_call POST "/chat/agent-response" "$NOTIFY_BODY" >/dev/null 2>&1 || true

# --- Step 5: Output result as safe JSON ---
jq -n \
  --arg from "$SESSION_NAME" \
  --arg to "$TO" \
  --arg reason "$REASON" \
  --arg taskPath "${TASK_PATH:-}" \
  --arg timestamp "$TIMESTAMP" \
  --argjson delivery "$(echo "$deliver_result" | jq '.' 2>/dev/null || echo '{"raw":"'"${deliver_result//\"/\\\"}"'"}')" \
  --argjson tracking "$(echo "$handoff_result" | jq '.' 2>/dev/null || echo '{"raw":"'"${handoff_result//\"/\\\"}"'"}')" \
  '{
    success: true,
    handoff: {
      from: $from,
      to: $to,
      reason: $reason,
      taskPath: (if $taskPath == "" then null else $taskPath end),
      timestamp: $timestamp
    },
    delivery: $delivery,
    tracking: $tracking
  }'

# --- Step 6: Persist handoff as project knowledge ---
auto_remember "$SESSION_NAME" "[HANDOFF] Task handoff from ${SESSION_NAME} to ${TO}: ${REASON}" "fact" "project" "$PROJECT_PATH"
