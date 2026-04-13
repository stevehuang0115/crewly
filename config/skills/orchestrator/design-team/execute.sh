#!/bin/bash
# Design and create a team from a natural language description.
# The runtime does the reasoning — this skill provides context.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# --- Input parsing ---
DESCRIPTION=""
PROJECT_PATH=""
INPUT_JSON=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --description|-d) DESCRIPTION="$2";    shift 2 ;;
    --project-path|-p) PROJECT_PATH="$2";  shift 2 ;;
    --json|-j) INPUT_JSON="$2";            shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --description 'Build a frontend team' [--project-path /path]"
      exit 0 ;;
    *) shift ;;
  esac
done

if [[ -n "$INPUT_JSON" ]]; then
  [[ -z "$DESCRIPTION" ]] && DESCRIPTION=$(echo "$INPUT_JSON" | jq -r '.description // empty' 2>/dev/null || true)
  [[ -z "$PROJECT_PATH" ]] && PROJECT_PATH=$(echo "$INPUT_JSON" | jq -r '.projectPath // empty' 2>/dev/null || true)
fi

require_param "description" "$DESCRIPTION"

# --- Load available templates ---
TEMPLATES_DATA=$(api_call GET "/templates" 2>/dev/null || echo '{"data":[]}')
TEMPLATES=$(echo "$TEMPLATES_DATA" | jq -r '
  .data // [] | map(
    "- " + .id + ": " + .name + " (" + (.category // "custom") + ", " + (.roles | length | tostring) + " roles)"
  ) | join("\n")
' 2>/dev/null || echo "No templates available")

# --- Load available roles ---
ROLES_DIR="${SCRIPT_DIR}/../../../roles"
ROLES=""
if [ -d "$ROLES_DIR" ]; then
  for role_dir in "$ROLES_DIR"/*/; do
    role_name=$(basename "$role_dir")
    if [ -f "${role_dir}role.json" ]; then
      role_desc=$(jq -r '.displayName // .name // "'$role_name'"' "${role_dir}role.json" 2>/dev/null || echo "$role_name")
      ROLES="${ROLES}\n- ${role_name}: ${role_desc}"
    fi
  done
fi

# --- Load existing teams ---
TEAMS_DATA=$(api_call GET "/teams" 2>/dev/null || echo '{"data":[]}')
EXISTING_TEAMS=$(echo "$TEAMS_DATA" | jq -r '
  .data // [] | map(
    "- " + .name + " (" + (.members | length | tostring) + " members)"
  ) | join("\n")
' 2>/dev/null || echo "No existing teams")

# --- Output context for the runtime ---
cat << DESIGN_PROMPT

## Team Design Request

Design a team based on this description:
**"${DESCRIPTION}"**

### Available Templates
${TEMPLATES}

### Available Roles
${ROLES:-No role definitions found}

### Existing Teams (avoid duplicates)
${EXISTING_TEAMS}

### Instructions

Design the team and output a valid JSON config. Consider:
1. **Team size** — How many members? What roles?
2. **Hierarchy** — Does this team need a TL? (teams > 2 people usually do)
3. **Ownership** — What domains and deliverables does this team own?
4. **Service contract** — What tasks does this team accept/avoid?
5. **Job titles** — Give each member a specific job title and description

If an existing template closely matches, reference it. Otherwise design from scratch.

Output JSON:
\`\`\`json
{
  "name": "Team Name",
  "description": "What this team does",
  "hierarchical": true,
  "mission": "Team mission statement",
  "ownershipScope": {
    "domains": ["frontend"],
    "deliverables": ["feature_delivery", "ui_quality"]
  },
  "serviceContract": {
    "accepts": ["frontend features", "UI bugfixes", "component library maintenance"],
    "avoids": ["backend API changes", "database migrations"],
    "expectedOutput": ["PR with tests", "Storybook documentation"]
  },
  "members": [
    {
      "name": "Sam",
      "role": "team-leader",
      "jobTitle": "Frontend Tech Lead",
      "jobDescription": "Owns frontend quality and architecture decisions",
      "ownershipScope": { "domains": ["frontend"], "deliverables": ["quality"] },
      "responsibilityType": "quality_owner",
      "autonomyLevel": "bounded",
      "canDelegate": true
    },
    {
      "name": "Leo",
      "role": "developer",
      "jobTitle": "Frontend Developer",
      "jobDescription": "Implements UI features and components",
      "ownershipScope": { "domains": ["frontend"], "areas": ["checkout-flow"] },
      "autonomyLevel": "directed"
    }
  ]${PROJECT_PATH:+,
  "projectPath": "${PROJECT_PATH}"}
}
\`\`\`

After generating the JSON, create the team:
\`\`\`bash
curl -s -X POST "${CREWLY_API_URL}/api/teams" \\
  -H "Content-Type: application/json" \\
  -d '<YOUR_JSON_OUTPUT>'
\`\`\`

Then confirm to the user: "Team created: [name] with [N] members. [list roles]. Ready to assign a project."

DESIGN_PROMPT

echo '{"success":true,"message":"Team design context provided to runtime"}'
