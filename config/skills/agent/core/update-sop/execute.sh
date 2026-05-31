#!/bin/bash
# Create or update a team's custom SOP.
# Writes to ~/.crewly/teams/{teamId}/sops/[{category}/]{sopId}.md
# (the per-team installed/custom SOP store the wiki surfaces under sop/).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

CREWLY_HOME="${HOME}/.crewly"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sopId\":\"xhs-posting\",\"title\":\"XHS Posting\",\"content\":\"...\",\"category\":\"common\"}'"

SOP_ID=$(printf '%s' "$INPUT" | jq -r '.sopId // empty')
TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // empty')
CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
APPEND=$(printf '%s' "$INPUT" | jq -r '.append // "false"')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
UPDATED_BY=$(printf '%s' "$INPUT" | jq -r '.updatedBy // empty')

require_param "sopId" "$SOP_ID"
require_param "content" "$CONTENT"

# Sanitize id/category to safe path segments (no traversal, no slashes).
SOP_ID=$(printf '%s' "$SOP_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//')
CATEGORY=$(printf '%s' "$CATEGORY" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g; s/^-*//; s/-*$//')
[ -z "$SOP_ID" ] && error_exit "sopId resolved to empty after sanitization"

# Resolve teamId: explicit param > lookup by sessionName > CREWLY_SESSION_NAME env
resolve_team_id() {
  local session="${1:-${CREWLY_SESSION_NAME:-}}"
  [ -z "$session" ] && return 1
  local teams_dir="${CREWLY_HOME}/teams"
  [ ! -d "$teams_dir" ] && return 1
  for config in "$teams_dir"/*/config.json; do
    [ -f "$config" ] || continue
    local found
    found=$(jq -r --arg s "$session" '.members[]? | select(.sessionName == $s) | "found"' "$config" 2>/dev/null | head -1)
    if [ "$found" = "found" ]; then
      basename "$(dirname "$config")"
      return 0
    fi
  done
  return 1
}

if [ -z "$TEAM_ID" ]; then
  TEAM_ID=$(resolve_team_id "$SESSION_NAME") || error_exit "Could not resolve teamId. Provide teamId or sessionName."
fi

SOPS_DIR="${CREWLY_HOME}/teams/${TEAM_ID}/sops"
if [ -n "$CATEGORY" ]; then
  SOPS_DIR="${SOPS_DIR}/${CATEGORY}"
  REL_PATH="sop/${CATEGORY}/${SOP_ID}.md"
else
  REL_PATH="sop/${SOP_ID}.md"
fi
mkdir -p "$SOPS_DIR"

SOP_FILE="${SOPS_DIR}/${SOP_ID}.md"
TODAY=$(date +%Y-%m-%d)
ACTION="created"

if [ -f "$SOP_FILE" ]; then
  ACTION="updated"
  EXISTING_TITLE=$(sed -n '/^---$/,/^---$/{ /^---$/d; s/^title: *//p; }' "$SOP_FILE" | head -1)
  EXISTING_UPDATED_BY=$(sed -n '/^---$/,/^---$/{ /^---$/d; s/^updatedBy: *//p; }' "$SOP_FILE" | head -1)
  [ -z "$TITLE" ] && TITLE="$EXISTING_TITLE"
  [ -z "$UPDATED_BY" ] && UPDATED_BY="$EXISTING_UPDATED_BY"

  if [ "$APPEND" = "true" ]; then
    EXISTING_CONTENT=""
    FM_DONE=false
    FM_COUNT=0
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$line" = "---" ]; then
        FM_COUNT=$((FM_COUNT + 1))
        if [ "$FM_COUNT" -ge 2 ]; then
          FM_DONE=true
          continue
        fi
      elif [ "$FM_DONE" = true ]; then
        EXISTING_CONTENT="${EXISTING_CONTENT}${line}
"
      fi
    done < "$SOP_FILE"
    EXISTING_CONTENT=$(echo "$EXISTING_CONTENT" | sed '/./,$!d')
    CONTENT="${EXISTING_CONTENT}
${CONTENT}"
  fi
else
  [ -z "$TITLE" ] && error_exit "title is required when creating a new SOP"
fi

{
  echo "---"
  echo "title: ${TITLE}"
  [ -n "$CATEGORY" ] && echo "category: ${CATEGORY}"
  [ -n "$UPDATED_BY" ] && echo "updatedBy: ${UPDATED_BY}"
  echo "updatedAt: ${TODAY}"
  echo "---"
  echo ""
  echo "$CONTENT"
} > "$SOP_FILE"

jq -n \
  --arg sopId "$SOP_ID" \
  --arg title "$TITLE" \
  --arg category "$CATEGORY" \
  --arg action "$ACTION" \
  --arg path "$SOP_FILE" \
  --arg relativePath "$REL_PATH" \
  '{success: true, action: $action, sopId: $sopId, title: $title, category: $category, path: $path, relativePath: $relativePath}'
