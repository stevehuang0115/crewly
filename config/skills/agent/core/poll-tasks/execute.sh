#!/bin/bash
# =============================================================================
# poll-tasks — Agent polls the Task Pool for available work and claims a match
#
# An idle agent calls this skill to find and claim work from the Task Pool.
# The skill queries available WorkItems, filters by agent capabilities, and
# claims the first matching item. Returns the claimed WorkItem for execution.
#
# Usage:
#   bash execute.sh '{"sessionName":"agent-1","role":"developer","skills":["typescript","react"]}'
#
# Parameters:
#   sessionName  (required) — Agent session name used as claimant ID
#   role         (optional) — Agent role for capability matching (developer, researcher, etc.)
#   skills       (optional) — JSON array of skill tags for fine-grained matching
#   types        (optional) — Comma-separated WorkItemTypes to filter (default: delegate,project_task,review)
#   projectPath  (optional) — Project path for memory persistence
#
# Returns:
#   On claim: { success: true, claimed: true, workItem: {...}, claim: {...} }
#   No match: { success: true, claimed: false, available: 0, message: "..." }
#   Error:    { error: "..." } on stderr, exit 1
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-1\",\"role\":\"developer\"}'"

# ---------------------------------------------------------------------------
# Parse parameters
# ---------------------------------------------------------------------------

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

ROLE=$(printf '%s' "$INPUT" | jq -r '.role // empty')
SKILLS_JSON=$(printf '%s' "$INPUT" | jq -c '.skills // []')
TYPES=$(printf '%s' "$INPUT" | jq -r '.types // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

# ---------------------------------------------------------------------------
# Defaults — which WorkItemTypes this agent can handle, keyed by role
# ---------------------------------------------------------------------------

if [ -z "$TYPES" ]; then
  case "${ROLE}" in
    developer)
      TYPES="delegate,project_task,review"
      ;;
    researcher|analyst)
      TYPES="delegate,check,review"
      ;;
    team_lead|team-lead)
      TYPES="delegate,project_task,review,check"
      ;;
    *)
      # Sensible default: delegate + project_task
      TYPES="delegate,project_task"
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Step 1: Query available WorkItems from Task Pool
# ---------------------------------------------------------------------------

QUERY_PARAMS="?types=${TYPES}&owner=agent"

AVAILABLE_RESPONSE=$(api_call GET "/task-pool${QUERY_PARAMS}" 2>&1) || {
  # Also try without owner filter — some items may target specific agents
  AVAILABLE_RESPONSE=$(api_call GET "/task-pool?types=${TYPES}&target=${SESSION_NAME}" 2>&1) || {
    error_exit "Failed to query Task Pool: ${AVAILABLE_RESPONSE}"
  }
}

AVAILABLE_COUNT=$(printf '%s' "$AVAILABLE_RESPONSE" | jq -r '.count // 0')

if [ "$AVAILABLE_COUNT" -eq 0 ]; then
  # No available work — return early
  jq -n \
    --argjson count "$AVAILABLE_COUNT" \
    '{success: true, claimed: false, available: $count, message: "No available work items matching agent capabilities"}'
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2: Skill-based filtering (client-side)
#
# If the agent declared skills (e.g. ["typescript","react"]), we check each
# available item's title + description for keyword overlap. Items whose
# title/description contain at least one of the agent's skills are preferred.
# If no skill-matched item exists, fall back to FIFO (server default).
# ---------------------------------------------------------------------------

SKILL_COUNT=$(printf '%s' "$SKILLS_JSON" | jq 'length')

if [ "$SKILL_COUNT" -gt 0 ]; then
  # Build a regex pattern from skills: typescript|react|...
  SKILL_PATTERN=$(printf '%s' "$SKILLS_JSON" | jq -r 'map(ascii_downcase) | join("|")')

  # Find first item whose title or description matches agent skills
  MATCHED_ITEM=$(printf '%s' "$AVAILABLE_RESPONSE" | jq -c --arg pat "$SKILL_PATTERN" '
    .data // [] |
    map(select(
      ((.title // "") | ascii_downcase | test($pat)) or
      ((.description // "") | ascii_downcase | test($pat))
    )) |
    first // null
  ')

  if [ "$MATCHED_ITEM" != "null" ] && [ -n "$MATCHED_ITEM" ]; then
    # Use target filter to claim this specific item if it has a target
    MATCHED_ID=$(printf '%s' "$MATCHED_ITEM" | jq -r '.id')
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Claim from the Task Pool
#
# The POST /api/task-pool/claim endpoint handles FIFO selection server-side.
# We pass our agentId and filters so the server picks the best match.
# ---------------------------------------------------------------------------

CLAIM_BODY=$(jq -n \
  --arg agentId "$SESSION_NAME" \
  --arg types "$TYPES" \
  '{
    agentId: $agentId,
    filters: {
      types: ($types | split(","))
    }
  }')

CLAIM_RESPONSE=$(api_call POST "/task-pool/claim" "$CLAIM_BODY" 2>&1) || {
  CLAIM_ERROR="$CLAIM_RESPONSE"
  # 404 = no available items (race condition — someone else claimed it)
  if printf '%s' "$CLAIM_ERROR" | grep -q '"status":404'; then
    jq -n '{success: true, claimed: false, available: 0, message: "No work items available (claimed by another agent)"}'
    exit 0
  fi
  error_exit "Failed to claim from Task Pool: ${CLAIM_ERROR}"
}

# ---------------------------------------------------------------------------
# Step 4: Extract result and return
# ---------------------------------------------------------------------------

WORK_ITEM=$(printf '%s' "$CLAIM_RESPONSE" | jq -c '.data.workItem // null')
CLAIM_OBJ=$(printf '%s' "$CLAIM_RESPONSE" | jq -c '.data.claim // null')

if [ "$WORK_ITEM" = "null" ] || [ -z "$WORK_ITEM" ]; then
  jq -n '{success: true, claimed: false, available: 0, message: "Claim returned no work item"}'
  exit 0
fi

WORK_ITEM_TITLE=$(printf '%s' "$WORK_ITEM" | jq -r '.title // "untitled"')
WORK_ITEM_ID=$(printf '%s' "$WORK_ITEM" | jq -r '.id // "unknown"')
CLAIM_ID=$(printf '%s' "$CLAIM_OBJ" | jq -r '.id // "unknown"')

# Persist the claim as a learning so the agent recovers context on restart
if [ -n "$PROJECT_PATH" ]; then
  auto_remember "$SESSION_NAME" \
    "Claimed WorkItem '${WORK_ITEM_TITLE}' (id: ${WORK_ITEM_ID}, claim: ${CLAIM_ID}) from Task Pool" \
    "fact" "agent" "$PROJECT_PATH"
fi

# Return structured result
jq -n \
  --argjson workItem "$WORK_ITEM" \
  --argjson claim "$CLAIM_OBJ" \
  --arg workItemId "$WORK_ITEM_ID" \
  --arg claimId "$CLAIM_ID" \
  '{
    success: true,
    claimed: true,
    workItemId: $workItemId,
    claimId: $claimId,
    workItem: $workItem,
    claim: $claim
  }'
