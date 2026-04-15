#!/bin/bash
# Measure a Key Result and submit the value.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# --- Input parsing ---
MISSION_ID=""
KR_ID=""
PROJECT_PATH=""
INPUT_JSON=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mission-id|-m)   MISSION_ID="$2";     shift 2 ;;
    --kr-id|-k)        KR_ID="$2";          shift 2 ;;
    --project-path|-p) PROJECT_PATH="$2";    shift 2 ;;
    --json|-j)         INPUT_JSON="$2";      shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --mission-id <uuid> --kr-id <uuid> --project-path /path"
      exit 0 ;;
    *) shift ;;
  esac
done

if [[ -n "$INPUT_JSON" ]]; then
  [[ -z "$MISSION_ID" ]] && MISSION_ID=$(echo "$INPUT_JSON" | jq -r '.missionId // empty' 2>/dev/null || true)
  [[ -z "$KR_ID" ]] && KR_ID=$(echo "$INPUT_JSON" | jq -r '.krId // empty' 2>/dev/null || true)
  [[ -z "$PROJECT_PATH" ]] && PROJECT_PATH=$(echo "$INPUT_JSON" | jq -r '.projectPath // empty' 2>/dev/null || true)
fi

require_param "mission-id" "$MISSION_ID"
require_param "kr-id" "$KR_ID"
require_param "project-path" "$PROJECT_PATH"

# --- Load KR data ---
KR_DATA=$(api_call GET "/missions/${MISSION_ID}/key-results/${KR_ID}" 2>/dev/null) || {
  echo '{"success":false,"error":"Failed to load Key Result"}' >&2
  exit 1
}

KR=$(echo "$KR_DATA" | jq -r '.data // empty')
TITLE=$(echo "$KR" | jq -r '.title // "Unknown KR"')
UNIT=$(echo "$KR" | jq -r '.unit // ""')
BASELINE=$(echo "$KR" | jq -r '.baseline // 0')
TARGET=$(echo "$KR" | jq -r '.target // 0')
CURRENT=$(echo "$KR" | jq -r '.current // 0')
SOURCE=$(echo "$KR" | jq -r '.measurementSource // "manual"')
CONFIG=$(echo "$KR" | jq -r '.measurementConfig // {} | tostring')

# --- Output measurement context ---
cat << MEASURE_PROMPT

## Key Result Measurement

### KR: ${TITLE}
- Current: ${CURRENT} ${UNIT}
- Baseline: ${BASELINE} ${UNIT}
- Target: ${TARGET} ${UNIT}
- Measurement Source: ${SOURCE}
- Config: ${CONFIG}

### Instructions
Measure the current value for this Key Result.

$(if [[ "$SOURCE" == "skill_output" ]]; then
  echo "Follow the measurement config above to collect the metric."
  echo "For example: run tests, check API latency, count deployments, etc."
else
  echo "Determine the current metric value based on the project state."
fi)

After measuring, submit the value:
\`\`\`bash
curl -s -X POST "${CREWLY_API_URL}/api/missions/${MISSION_ID}/key-results/${KR_ID}/measure" \\
  -H "Content-Type: application/json" \\
  -d '{"value": <MEASURED_VALUE>, "source": "measure-kr-skill", "note": "Brief description of how measured"}'
\`\`\`

MEASURE_PROMPT

echo '{"success":true,"message":"Measurement context provided","missionId":"'"${MISSION_ID}"'","krId":"'"${KR_ID}"'"}'
