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
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"from-agent\",\"to\":\"target-session\",\"workItemId\":\"abc-123\",\"reason\":\"...\",\"progress\":\"...\"}'"

# --- Parse parameters ---
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // empty')
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

# --- Step 0: Resolve target WorkItem if not supplied ---
# Resolve order: explicit workItemId > the agent's currently-running claim.
if [ -z "$WORK_ITEM_ID" ]; then
  POOL_RESP=$(api_call GET "/task-pool/items?status=running&target=${SESSION_NAME}" 2>/dev/null || echo '{}')
  WORK_ITEM_ID=$(echo "$POOL_RESP" | jq -r '.workItems[0].id // .data[0].id // empty' 2>/dev/null || true)
fi

# --- Step 1: Fission guard check (rate limit before handoff) ---
# Non-blocking: if the fission API is unavailable, proceed with handoff.
FISSION_BODY=$(jq -n \
  --arg parentWorkItemId "${WORK_ITEM_ID:-handoff-stub}" \
  --arg agentId "$SESSION_NAME" \
  '{parentWorkItemId: $parentWorkItemId, agentId: $agentId}')

fission_result=$(api_call POST "/fission/check" "$FISSION_BODY" 2>/dev/null) || fission_result='{"success":false}'
fission_allowed=$(echo "$fission_result" | jq -r '.data.allowed // "true"')

if [ "$fission_allowed" = "false" ]; then
  fission_reason=$(echo "$fission_result" | jq -r '.data.reason // "Fission guard blocked this handoff"')
  echo "{\"success\":false,\"error\":\"Fission guard: ${fission_reason}\"}"
  exit 1
fi

# --- Step 2: Record handoff via V3 (reassigns target on the WorkItem) ---
# Spec 2026-05-06-task-management-v1-deprecation.md: handoff is now a
# `target` field flip on the WorkItem plus an audit-trail note. The legacy
# `/task-management/handoff` endpoint (which moved a `.md` file between
# agent task directories) is gone.
if [ -n "$WORK_ITEM_ID" ]; then
  HANDOFF_BODY=$(jq -n \
    --arg fromAgent "$SESSION_NAME" \
    --arg newTarget "$TO" \
    --arg reason "$REASON" \
    '{newTarget: $newTarget, fromAgent: $fromAgent, reason: $reason}')

  echo "Recording handoff ${SESSION_NAME} → ${TO} on WI ${WORK_ITEM_ID}..." >&2
  handoff_result=$(api_call POST "/task-pool/items/${WORK_ITEM_ID}/handoff" "$HANDOFF_BODY" 2>/dev/null) \
    || handoff_result='{"tracked":false,"error":"handoff API unavailable"}'
else
  handoff_result='{"tracked":false,"warning":"no active WorkItem for handing-off agent"}'
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

if [ -n "$WORK_ITEM_ID" ]; then
  printf '\n## WorkItem\n%s\n' "$WORK_ITEM_ID" >> "$HANDOFF_MSG_FILE"
  printf '\nFetch full brief: bash %s/config/skills/agent/core/read-task/execute.sh '"'"'{"workItemId":"%s"}'"'"'\n' \
    "$CREWLY_ROOT" "$WORK_ITEM_ID" >> "$HANDOFF_MSG_FILE"
fi

cat >> "$HANDOFF_MSG_FILE" << FOOTER_EOF

---
When done, report back with report-status, passing the workItemId from your [CREWLY-DISPATCH] notice (or from get-my-tasks) so the right WorkItem is closed: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{"sessionName":"${TO}","workItemId":"<your WorkItem id>","status":"done","summary":"<brief summary>","projectPath":"${PROJECT_PATH}"}'
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
  --arg workItemId "${WORK_ITEM_ID:-}" \
  --arg timestamp "$TIMESTAMP" \
  --argjson delivery "$(echo "$deliver_result" | jq '.' 2>/dev/null || echo '{"raw":"'"${deliver_result//\"/\\\"}"'"}')" \
  --argjson tracking "$(echo "$handoff_result" | jq '.' 2>/dev/null || echo '{"raw":"'"${handoff_result//\"/\\\"}"'"}')" \
  '{
    success: true,
    handoff: {
      from: $from,
      to: $to,
      reason: $reason,
      workItemId: (if $workItemId == "" then null else $workItemId end),
      timestamp: $timestamp
    },
    delivery: $delivery,
    tracking: $tracking
  }'

# --- Step 6: Persist handoff as project knowledge ---
auto_remember "$SESSION_NAME" "[HANDOFF] Task handoff from ${SESSION_NAME} to ${TO}: ${REASON}" "fact" "project" "$PROJECT_PATH"
