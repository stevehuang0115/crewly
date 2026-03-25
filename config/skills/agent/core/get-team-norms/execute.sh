#!/bin/bash
# Retrieve team norms/SOPs from local filesystem
# Reads ~/.crewly/teams/{teamId}/norms/*.md files
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

CREWLY_HOME="${HOME}/.crewly"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"trigger\":\"before_commit\",\"teamId\":\"...\"}'"

TRIGGER=$(printf '%s' "$INPUT" | jq -r '.trigger // empty')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')

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

if [ ! -d "$NORMS_DIR" ]; then
  echo '{"success":true,"data":[],"message":"No norms directory found"}'
  exit 0
fi

# Collect all .md files
NORMS="[]"
for file in "$NORMS_DIR"/*.md; do
  [ -f "$file" ] || continue

  NORM_ID=$(basename "$file" .md)

  # Parse YAML frontmatter (between --- delimiters)
  FRONTMATTER=""
  IN_FM=false
  FM_DONE=false
  CONTENT_LINES=""
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$FM_DONE" = true ]; then
      CONTENT_LINES="${CONTENT_LINES}${line}
"
    elif [ "$IN_FM" = false ] && [ "$line" = "---" ]; then
      IN_FM=true
    elif [ "$IN_FM" = true ] && [ "$line" = "---" ]; then
      IN_FM=false
      FM_DONE=true
    elif [ "$IN_FM" = true ]; then
      FRONTMATTER="${FRONTMATTER}${line}
"
    else
      # No frontmatter in file, treat everything as content
      CONTENT_LINES="${line}
"
      FM_DONE=true
    fi
  done < "$file"

  # Extract frontmatter fields with simple parsing
  FM_TITLE=$(echo "$FRONTMATTER" | sed -n 's/^title: *//p' | head -1)
  FM_TRIGGER=$(echo "$FRONTMATTER" | sed -n 's/^trigger: *//p' | head -1)
  FM_UPDATED_BY=$(echo "$FRONTMATTER" | sed -n 's/^updatedBy: *//p' | head -1)
  FM_UPDATED_AT=$(echo "$FRONTMATTER" | sed -n 's/^updatedAt: *//p' | head -1)

  # If trigger filter is set, skip non-matching norms
  if [ -n "$TRIGGER" ] && [ "$FM_TRIGGER" != "$TRIGGER" ]; then
    continue
  fi

  # Remove leading blank lines from content
  CONTENT_LINES=$(echo "$CONTENT_LINES" | sed '/./,$!d')

  # Build JSON entry
  ENTRY=$(jq -n \
    --arg normId "$NORM_ID" \
    --arg title "$FM_TITLE" \
    --arg trigger "$FM_TRIGGER" \
    --arg updatedBy "$FM_UPDATED_BY" \
    --arg updatedAt "$FM_UPDATED_AT" \
    --arg content "$CONTENT_LINES" \
    '{normId: $normId, title: $title, trigger: $trigger, updatedBy: $updatedBy, updatedAt: $updatedAt, content: $content}')

  NORMS=$(echo "$NORMS" | jq --argjson entry "$ENTRY" '. + [$entry]')
done

COUNT=$(echo "$NORMS" | jq 'length')
echo "$NORMS" | jq -c --arg count "$COUNT" '{success: true, count: ($count | tonumber), data: .}'
