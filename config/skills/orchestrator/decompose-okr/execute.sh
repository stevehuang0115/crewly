#!/bin/bash
# Decompose a parent Mission's OKR into child OKRs one cascade tier down,
# as a PROPOSAL (pending_approval). The runtime does the thinking — this skill
# provides parent context and collects the structured proposal. Children are
# NOT active until the human owner approves.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# --- Input parsing ---
MISSION_ID=""
PROJECT_PATH=""
INPUT_JSON=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mission-id|-m)   MISSION_ID="$2";     shift 2 ;;
    --project-path|-p) PROJECT_PATH="$2";    shift 2 ;;
    --json|-j)         INPUT_JSON="$2";      shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --mission-id <parent-uuid> [--project-path /path]"
      exit 0 ;;
    *) shift ;;
  esac
done

# Legacy JSON fallback
if [[ -n "$INPUT_JSON" ]]; then
  [[ -z "$MISSION_ID" ]] && MISSION_ID=$(echo "$INPUT_JSON" | jq -r '.missionId // .["mission-id"] // empty' 2>/dev/null || true)
  [[ -z "$PROJECT_PATH" ]] && PROJECT_PATH=$(echo "$INPUT_JSON" | jq -r '.projectPath // .["project-path"] // empty' 2>/dev/null || true)
fi

require_param "mission-id" "$MISSION_ID"

# --- Load parent Mission data ---
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
PARENT_LEVEL=$(echo "$MISSION" | jq -r '.level // "team"')
APPROVAL_STATE=$(echo "$MISSION" | jq -r '.approval.state // "approved"')

# --- Guard: parent must be approved/active to decompose ---
if [[ "$APPROVAL_STATE" != "approved" ]]; then
  echo '{"success":false,"error":"Parent mission is not approved; only approved missions can be decomposed (state: '"${APPROVAL_STATE}"')"}' >&2
  exit 1
fi

# --- Determine the child level (one tier down) ---
CHILD_LEVEL=""
PROJECT_ID_HINT="(not required at this tier)"
case "$PARENT_LEVEL" in
  company) CHILD_LEVEL="team" ;;
  team)    CHILD_LEVEL="project"; PROJECT_ID_HINT="REQUIRED — each child must set \"projectId\"" ;;
  project)
    echo '{"success":false,"error":"A project-level mission is the bottom of the cascade and cannot be decomposed further"}' >&2
    exit 1 ;;
  *) CHILD_LEVEL="team" ;;
esac

# --- Output decomposition context for the runtime ---
cat << DECOMPOSE_PROMPT

## OKR Cascade Decomposition Request

You are drafting **${CHILD_LEVEL}-level** child OKRs that decompose the parent
**${PARENT_LEVEL}-level** OKR below. This is a PROPOSAL — the children are NOT
active until the human owner (Steve) approves them.

### Parent OKR (${PARENT_LEVEL})
**Objective:** ${OBJECTIVE}
**Success Criteria:** ${CRITERIA}
**Current Strategy:** ${STRATEGY}

### Your task
Produce child OKRs at level **${CHILD_LEVEL}**. Each child must:
- have a clear objective that supports the parent objective
- have a currentStrategy describing how it will be pursued
- have 1-4 measurable Key Results (title, metricType, baseline, target, unit)
- projectId: ${PROJECT_ID_HINT}

Output a valid JSON object matching this schema:
\`\`\`json
{
  "children": [
    {
      "objective": "Child OKR objective",
      "currentStrategy": "How this child will pursue the objective",
      "successCriteria": ["narrative criterion"],
      "projectId": "set-only-when-child-level-is-project",
      "keyResults": [
        {
          "title": "Measurable Key Result",
          "metricType": "number",
          "baseline": 0,
          "target": 100,
          "unit": "signups"
        }
      ]
    }
  ]
}
\`\`\`

After generating the JSON, submit the proposal (children are created as
\`pending_approval\`):
\`\`\`bash
curl -s -X POST "${CREWLY_API_URL}/api/missions/${MISSION_ID}/decompose-okr" \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Session: \${CREWLY_SESSION_NAME:-}" \\
  -d '<YOUR_JSON_OUTPUT>'
\`\`\`

The response returns \`childMissionIds\`. Then surface the proposal to the owner
for a decision using the [APPROVE] block below.

[APPROVE]
parent: ${MISSION_ID} (${PARENT_LEVEL}) — ${OBJECTIVE}
proposed: ${CHILD_LEVEL}-level child OKRs are PENDING your approval.
approve: POST ${CREWLY_API_URL}/api/missions/<childMissionId>/approve
reject:  POST ${CREWLY_API_URL}/api/missions/<childMissionId>/reject  body: {"reason":"why"}
list:    GET  ${CREWLY_API_URL}/api/missions/${MISSION_ID}/proposals
[/APPROVE]

DECOMPOSE_PROMPT

echo '{"success":true,"message":"OKR decomposition context provided to runtime","missionId":"'"${MISSION_ID}"'","parentLevel":"'"${PARENT_LEVEL}"'","childLevel":"'"${CHILD_LEVEL}"'"}'
