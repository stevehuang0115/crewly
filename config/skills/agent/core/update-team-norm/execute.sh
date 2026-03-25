#!/bin/bash
# Create or update a team norm/SOP file
# Writes to ~/.crewly/teams/{teamId}/norms/{normId}.md
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

CREWLY_HOME="${HOME}/.crewly"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"normId\":\"code-commit\",\"title\":\"Code Commit SOP\",\"content\":\"...\"}'"

NORM_ID=$(printf '%s' "$INPUT" | jq -r '.normId // empty')
TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
TRIGGER=$(printf '%s' "$INPUT" | jq -r '.trigger // empty')
CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
APPEND=$(printf '%s' "$INPUT" | jq -r '.append // "false"')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
UPDATED_BY=$(printf '%s' "$INPUT" | jq -r '.updatedBy // empty')

require_param "normId" "$NORM_ID"
require_param "content" "$CONTENT"

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

NORMS_DIR="${CREWLY_HOME}/teams/${TEAM_ID}/norms"
mkdir -p "$NORMS_DIR"

NORM_FILE="${NORMS_DIR}/${NORM_ID}.md"
TODAY=$(date +%Y-%m-%d)
ACTION="created"

if [ -f "$NORM_FILE" ]; then
  ACTION="updated"

  # Read existing frontmatter values as defaults
  EXISTING_TITLE=$(sed -n '/^---$/,/^---$/{ /^---$/d; s/^title: *//p; }' "$NORM_FILE" | head -1)
  EXISTING_TRIGGER=$(sed -n '/^---$/,/^---$/{ /^---$/d; s/^trigger: *//p; }' "$NORM_FILE" | head -1)
  EXISTING_UPDATED_BY=$(sed -n '/^---$/,/^---$/{ /^---$/d; s/^updatedBy: *//p; }' "$NORM_FILE" | head -1)

  # Use existing values as fallbacks
  [ -z "$TITLE" ] && TITLE="$EXISTING_TITLE"
  [ -z "$TRIGGER" ] && TRIGGER="$EXISTING_TRIGGER"
  [ -z "$UPDATED_BY" ] && UPDATED_BY="$EXISTING_UPDATED_BY"

  # Handle append mode
  if [ "$APPEND" = "true" ]; then
    # Extract existing content (everything after second ---)
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
    done < "$NORM_FILE"

    # Trim leading blank lines from existing content
    EXISTING_CONTENT=$(echo "$EXISTING_CONTENT" | sed '/./,$!d')

    CONTENT="${EXISTING_CONTENT}
${CONTENT}"
  fi
else
  # New file: title is required
  [ -z "$TITLE" ] && error_exit "title is required when creating a new norm"
fi

# Build the norm file
{
  echo "---"
  echo "title: ${TITLE}"
  [ -n "$TRIGGER" ] && echo "trigger: ${TRIGGER}"
  [ -n "$UPDATED_BY" ] && echo "updatedBy: ${UPDATED_BY}"
  echo "updatedAt: ${TODAY}"
  echo "---"
  echo ""
  echo "$CONTENT"
} > "$NORM_FILE"

jq -n \
  --arg normId "$NORM_ID" \
  --arg title "$TITLE" \
  --arg trigger "$TRIGGER" \
  --arg action "$ACTION" \
  --arg path "$NORM_FILE" \
  '{success: true, action: $action, normId: $normId, title: $title, trigger: $trigger, path: $path}'
