#!/bin/bash
# Design an acceptance checklist for an objective BEFORE execution.
# The checklist is stored and must be approved by the superior before
# the TL proceeds with decompose-goal and delegate-task.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# --- Input parsing ---
OBJECTIVE=""
PROJECT_PATH=""
TASK_ID=""
TEAM_ID=""
MISSION_ID=""
INPUT_JSON=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --objective|-o)     OBJECTIVE="$2";      shift 2 ;;
    --project-path|-p)  PROJECT_PATH="$2";   shift 2 ;;
    --task-id|-t)       TASK_ID="$2";        shift 2 ;;
    --team-id|-g)       TEAM_ID="$2";        shift 2 ;;
    --mission-id|-m)    MISSION_ID="$2";     shift 2 ;;
    --json|-j)          INPUT_JSON="$2";     shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --objective 'Build auth' --project-path /path --task-id task-123 [--team-id team-456] [--mission-id mission-789]"
      exit 0 ;;
    *) shift ;;
  esac
done

# Legacy JSON fallback
if [[ -n "$INPUT_JSON" ]]; then
  [[ -z "$OBJECTIVE" ]]    && OBJECTIVE=$(echo "$INPUT_JSON" | jq -r '.objective // empty' 2>/dev/null || true)
  [[ -z "$PROJECT_PATH" ]] && PROJECT_PATH=$(echo "$INPUT_JSON" | jq -r '.projectPath // empty' 2>/dev/null || true)
  [[ -z "$TASK_ID" ]]      && TASK_ID=$(echo "$INPUT_JSON" | jq -r '.taskId // empty' 2>/dev/null || true)
  [[ -z "$TEAM_ID" ]]      && TEAM_ID=$(echo "$INPUT_JSON" | jq -r '.teamId // empty' 2>/dev/null || true)
  [[ -z "$MISSION_ID" ]]   && MISSION_ID=$(echo "$INPUT_JSON" | jq -r '.missionId // empty' 2>/dev/null || true)
fi

require_param "objective" "$OBJECTIVE"
require_param "project-path" "$PROJECT_PATH"
require_param "task-id" "$TASK_ID"

# --- Load context for checklist generation ---

# Load Mission success criteria if mission linked
MISSION_CRITERIA=""
if [[ -n "$MISSION_ID" ]]; then
  MISSION_DATA=$(api_call GET "/missions/${MISSION_ID}" 2>/dev/null || true)
  if [[ -n "$MISSION_DATA" ]]; then
    MISSION_CRITERIA=$(echo "$MISSION_DATA" | jq -r '.data.successCriteria // [] | join("\n- ")' 2>/dev/null || true)
  fi
fi

# Load team template verification pipeline if team linked
TEMPLATE_PIPELINE=""
if [[ -n "$TEAM_ID" ]]; then
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || true)
  if [[ -n "$TEAM_DATA" ]]; then
    TEMPLATE_ID=$(echo "$TEAM_DATA" | jq -r '.data.templateId // empty' 2>/dev/null || true)
    if [[ -n "$TEMPLATE_ID" ]]; then
      TEMPLATE_DATA=$(api_call GET "/templates/${TEMPLATE_ID}" 2>/dev/null || true)
      if [[ -n "$TEMPLATE_DATA" ]]; then
        TEMPLATE_PIPELINE=$(echo "$TEMPLATE_DATA" | jq -r '
          .data.verificationPipeline.steps // [] |
          map("- " + (.method // "check") + ": " + (.description // .name // "unnamed step")) |
          join("\n")
        ' 2>/dev/null || true)
      fi
    fi
  fi
fi

# --- Output context for the runtime to generate checklist ---
# The TL runtime (Claude Code / Gemini CLI) reads this and produces
# the structured checklist. This is the key "no new LLM layer" design.

cat << CHECKLIST_PROMPT

## Acceptance Checklist Design

You are designing an acceptance checklist for this objective BEFORE execution begins.
This checklist will be sent to your superior (Orchestrator) for approval.
Once approved, you will use it to verify workers' output after task completion.

### Objective
${OBJECTIVE}

### Mission Success Criteria (align with these)
${MISSION_CRITERIA:-No mission linked — design criteria based on the objective itself.}

### Team Verification Pipeline (baseline checks)
${TEMPLATE_PIPELINE:-No template pipeline — design checks from scratch.}

### Instructions

Design a verification checklist with 3-8 items. Each item should be:
- **Concrete and measurable** — not vague ("good code" is bad, "all tests pass" is good)
- **Aligned with Mission criteria** if available
- **Categorized**: functionality, quality, security, performance, documentation

For each item, specify:
- \`id\`: unique identifier (e.g., "chk-1")
- \`category\`: functionality | quality | security | performance | documentation
- \`description\`: what is being verified
- \`type\`: "command" (automated check) or "manual" (TL judgment)
- \`command\`: shell command to run (only for type=command)
- \`critical\`: true if this is a must-pass item, false if nice-to-have

Output valid JSON matching this schema:
\`\`\`json
{
  "taskId": "${TASK_ID}",
  "objective": "${OBJECTIVE}",
  "status": "pending_approval",
  "createdBy": "${CREWLY_SESSION_NAME:-tl}",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "items": [
    {
      "id": "chk-1",
      "category": "functionality",
      "description": "Description of what to verify",
      "type": "command",
      "command": "npm test",
      "critical": true
    }
  ]
}
\`\`\`

After generating the JSON, save it and submit for approval:
\`\`\`bash
# Save checklist
cat > "${PROJECT_PATH}/.crewly/tasks/checklist-${TASK_ID}.json" << 'CHECKLIST_EOF'
<YOUR_JSON_OUTPUT>
CHECKLIST_EOF

# Submit for approval
curl -s -X POST "${CREWLY_API_URL}/api/task-management/${TASK_ID}/checklist" \\
  -H "Content-Type: application/json" \\
  -d @"${PROJECT_PATH}/.crewly/tasks/checklist-${TASK_ID}.json"
\`\`\`

Then notify your superior:
"I've designed the acceptance checklist for '${OBJECTIVE}'. Please review and approve before I proceed with task decomposition."

**Do NOT start decompose-goal or delegate-task until the checklist is approved.**

CHECKLIST_PROMPT

echo '{"success":true,"message":"Checklist design context provided to runtime","taskId":"'"${TASK_ID}"'"}'
