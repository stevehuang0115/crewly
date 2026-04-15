#!/bin/bash
# Review a Mission's OKR progress and decide next action.
# The runtime does the thinking — this skill provides context and collects output.
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
      echo "Usage: execute.sh --mission-id <uuid> --project-path /path"
      exit 0 ;;
    *) shift ;;
  esac
done

if [[ -n "$INPUT_JSON" ]]; then
  [[ -z "$MISSION_ID" ]] && MISSION_ID=$(echo "$INPUT_JSON" | jq -r '.missionId // .["mission-id"] // empty' 2>/dev/null || true)
  [[ -z "$PROJECT_PATH" ]] && PROJECT_PATH=$(echo "$INPUT_JSON" | jq -r '.projectPath // .["project-path"] // empty' 2>/dev/null || true)
fi

require_param "mission-id" "$MISSION_ID"
require_param "project-path" "$PROJECT_PATH"

# --- Load Mission data ---
MISSION_DATA=$(api_call GET "/missions/${MISSION_ID}" 2>/dev/null) || {
  echo '{"success":false,"error":"Failed to load mission"}' >&2
  exit 1
}

MISSION=$(echo "$MISSION_DATA" | jq -r '.data // empty')
OBJECTIVE=$(echo "$MISSION" | jq -r '.objective // "No objective"')
STRATEGY=$(echo "$MISSION" | jq -r '.currentStrategy // "No strategy"')
LEARNINGS=$(echo "$MISSION" | jq -r '.learnings // [] | join("\n- ")')
LAST_REVIEW=$(echo "$MISSION" | jq -r '.lastReviewSummary // "No previous review"')

# --- Load OKR Summary ---
OKR_SUMMARY=$(api_call GET "/missions/${MISSION_ID}/okr-summary" 2>/dev/null || echo '{"data":{}}')
OKR_DATA=$(echo "$OKR_SUMMARY" | jq -r '.data // {}')

# --- Load Task Progress ---
PROGRESS=$(api_call GET "/missions/${MISSION_ID}/progress" 2>/dev/null || echo '{"data":{}}')
PROGRESS_DATA=$(echo "$PROGRESS" | jq -r '.data // {}')

# --- Load Key Results ---
KR_LIST=$(api_call GET "/missions/${MISSION_ID}/key-results" 2>/dev/null || echo '{"data":[]}')
KR_DETAILS=$(echo "$KR_LIST" | jq -r '.data // [] | map(
  "- \(.title): \(.current)\(.unit) / \(.target)\(.unit) [\(.status)] (\(if .baseline > .target then "lower is better" else "higher is better" end))"
) | join("\n")' 2>/dev/null || echo "No KR data")

# --- Output review context for the runtime ---
cat << REVIEW_PROMPT

## OKR Review — Mission ${MISSION_ID}

### Objective
${OBJECTIVE}

### Current Strategy
${STRATEGY}

### Key Results Progress
${KR_DETAILS:-No key results defined}

### OKR Summary
- Overall Progress: $(echo "$OKR_DATA" | jq -r '.overallProgress // 0')%
- Achieved: $(echo "$OKR_DATA" | jq -r '.achieved // 0') / $(echo "$OKR_DATA" | jq -r '.totalKRs // 0')
- On Track: $(echo "$OKR_DATA" | jq -r '.onTrack // 0')
- At Risk: $(echo "$OKR_DATA" | jq -r '.atRisk // 0')
- Off Track: $(echo "$OKR_DATA" | jq -r '.offTrack // 0')
- System Recommendation: $(echo "$OKR_DATA" | jq -r '.recommendation // "N/A"')

### Task Progress
- Total: $(echo "$PROGRESS_DATA" | jq -r '.totalTasks // 0')
- Completed: $(echo "$PROGRESS_DATA" | jq -r '.completedTasks // 0')
- Running: $(echo "$PROGRESS_DATA" | jq -r '.runningTasks // 0')
- Blocked: $(echo "$PROGRESS_DATA" | jq -r '.blockedTasks // 0')
- Failed: $(echo "$PROGRESS_DATA" | jq -r '.failedTasks // 0')

### Previous Review
${LAST_REVIEW}

### Learnings So Far
${LEARNINGS:-None recorded}

### Instructions
Based on the KR progress and task status above, decide the next action:

1. **continue** — KRs are progressing well, keep current strategy
2. **adjust_strategy** — KRs are slipping; propose a modified strategy
3. **replan_phase** — Strategy is fundamentally not working; cancel remaining tasks and redesign
4. **add_tasks** — Strategy is working but missing tasks needed
5. **cancel_mission** — Mission is no longer viable

Output a valid JSON ReviewDecision:
\`\`\`json
{
  "action": "continue",
  "newStrategy": "optional new strategy text",
  "learnings": ["what we learned"],
  "krUpdates": []
}
\`\`\`

After generating the decision, submit it:
\`\`\`bash
curl -s -X POST "${CREWLY_API_URL}/api/missions/${MISSION_ID}/review-decision" \\
  -H "Content-Type: application/json" \\
  -d '<YOUR_JSON_OUTPUT>'
\`\`\`

REVIEW_PROMPT

echo '{"success":true,"message":"Review context provided to runtime","missionId":"'"${MISSION_ID}"'"}'
