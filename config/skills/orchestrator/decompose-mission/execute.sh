#!/bin/bash
# Decompose a Mission into concrete tasks with dependencies.
# The runtime does the thinking — this skill provides context and collects output.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# --- Input parsing ---
MISSION_ID=""
PROJECT_PATH=""
PHASE="1"
INPUT_JSON=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mission-id|-m)   MISSION_ID="$2";     shift 2 ;;
    --project-path|-p) PROJECT_PATH="$2";    shift 2 ;;
    --phase)           PHASE="$2";           shift 2 ;;
    --json|-j)         INPUT_JSON="$2";      shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --mission-id <uuid> --project-path /path [--phase 1]"
      exit 0 ;;
    *) shift ;;
  esac
done

# Legacy JSON fallback
if [[ -n "$INPUT_JSON" ]]; then
  [[ -z "$MISSION_ID" ]] && MISSION_ID=$(echo "$INPUT_JSON" | jq -r '.missionId // .["mission-id"] // empty' 2>/dev/null || true)
  [[ -z "$PROJECT_PATH" ]] && PROJECT_PATH=$(echo "$INPUT_JSON" | jq -r '.projectPath // .["project-path"] // empty' 2>/dev/null || true)
  [[ "$PHASE" == "1" ]] && PHASE=$(echo "$INPUT_JSON" | jq -r '.phase // "1"' 2>/dev/null || echo "1")
fi

require_param "mission-id" "$MISSION_ID"
require_param "project-path" "$PROJECT_PATH"

# --- Load Mission data ---
MISSION_DATA=$(api_call GET "/missions/${MISSION_ID}" 2>/dev/null) || {
  echo '{"success":false,"error":"Failed to load mission"}' >&2
  exit 1
}

MISSION=$(echo "$MISSION_DATA" | jq -r '.data // empty')
if [[ -z "$MISSION" || "$MISSION" == "null" ]]; then
  echo '{"success":false,"error":"Mission not found"}' >&2
  exit 1
fi

OBJECTIVE=$(echo "$MISSION" | jq -r '.objective // "No objective"')
CRITERIA=$(echo "$MISSION" | jq -r '.successCriteria // [] | join("; ")')
STRATEGY=$(echo "$MISSION" | jq -r '.currentStrategy // "No strategy set"')
POLICY_LEVEL=$(echo "$MISSION" | jq -r '.policy.maxParallelExecutions // 3')

# --- Load team data ---
TEAM_ID=$(echo "$MISSION" | jq -r '.ownerTeamId // empty')
TEAM_INFO=""
if [[ -n "$TEAM_ID" ]]; then
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || true)
  if [[ -n "$TEAM_DATA" ]]; then
    TEAM_INFO=$(echo "$TEAM_DATA" | jq -r '
      .data.members // [] | map(
        "- \(.name // .sessionName) (\(.role // "developer"))"
      ) | join("\n")
    ' 2>/dev/null || echo "Team data unavailable")
  fi
fi

# --- Output decomposition context for the runtime ---
# The runtime (Claude Code / Gemini CLI) will read this and produce
# the structured task breakdown. We output this as the skill result
# which becomes the context for the agent.

cat << DECOMPOSE_PROMPT

## Mission Decomposition Request — Phase ${PHASE}

### Objective
${OBJECTIVE}

### Success Criteria
${CRITERIA}

### Current Strategy
${STRATEGY}

### Available Team
${TEAM_INFO:-No team info available}

### Constraints
- Max parallel tasks: ${POLICY_LEVEL}
- Each task should be completable by one agent in 30 minutes to 2 hours
- Phase ${PHASE}: provide full detail with concrete, actionable tasks
- Later phases: provide only outlines (will be refined when this phase completes)

### Instructions
Break this mission into concrete tasks for Phase ${PHASE}. For each task specify:
- title: clear, actionable task name
- description: what needs to be done (2-3 sentences)
- type: "delegate" (for agent work) or "review" (for verification)
- priority: "critical" | "high" | "medium" | "low"
- suggestedRole: "developer" | "qa" | "designer" | "architect"
- estimatedMinutes: expected duration (30-120)
- dependsOn: array of task titles this depends on (empty if independent)

Output a valid JSON object matching this schema:
\`\`\`json
{
  "missionId": "${MISSION_ID}",
  "phase": ${PHASE},
  "tasks": [
    {
      "title": "Task title",
      "description": "What to do",
      "type": "delegate",
      "priority": "high",
      "suggestedRole": "developer",
      "estimatedMinutes": 60,
      "dependsOn": []
    }
  ]
}
\`\`\`

After generating the JSON, call the following to submit the decomposition:
\`\`\`bash
curl -s -X POST "${CREWLY_API_URL}/api/missions/${MISSION_ID}/decompose" \\
  -H "Content-Type: application/json" \\
  -d '<YOUR_JSON_OUTPUT>'
\`\`\`

DECOMPOSE_PROMPT

echo '{"success":true,"message":"Decomposition context provided to runtime","missionId":"'"${MISSION_ID}"'","phase":'"${PHASE}"'}'
