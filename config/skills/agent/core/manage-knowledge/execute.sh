#!/bin/bash
# Manage Knowledge Documents - create or update company knowledge docs
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"create\",\"title\":\"...\",\"content\":\"...\",\"category\":\"SOPs\",\"scope\":\"global\"}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
require_param "action" "$ACTION"

if [ "$ACTION" = "create" ]; then
  TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
  CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // "General"')
  SCOPE=$(printf '%s' "$INPUT" | jq -r '.scope // "global"')
  PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  TAGS=$(printf '%s' "$INPUT" | jq -c '.tags // []')
  CREATED_BY=$(printf '%s' "$INPUT" | jq -r '.createdBy // "agent"')

  require_param "title" "$TITLE"
  require_param "content" "$CONTENT"

  BODY=$(jq -n \
    --arg title "$TITLE" \
    --arg content "$CONTENT" \
    --arg category "$CATEGORY" \
    --arg scope "$SCOPE" \
    --arg projectPath "$PROJECT_PATH" \
    --argjson tags "$TAGS" \
    --arg createdBy "$CREATED_BY" \
    '{title: $title, content: $content, category: $category, scope: $scope, projectPath: $projectPath, tags: $tags, createdBy: $createdBy}')

  api_call POST "/knowledge/documents" "$BODY"

elif [ "$ACTION" = "update" ]; then
  ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
  require_param "id" "$ID"

  SCOPE=$(printf '%s' "$INPUT" | jq -r '.scope // "global"')
  PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  UPDATED_BY=$(printf '%s' "$INPUT" | jq -r '.updatedBy // "agent"')

  # Build update body with only provided fields
  BODY=$(printf '%s' "$INPUT" | jq '{
    title: .title,
    content: .content,
    category: .category,
    tags: .tags,
    scope: (.scope // "global"),
    projectPath: .projectPath,
    updatedBy: (.updatedBy // "agent")
  } | with_entries(select(.value != null and .value != ""))')

  api_call PUT "/knowledge/documents/${ID}" "$BODY"

else
  error_exit "Invalid action '${ACTION}'. Must be 'create' or 'update'"
fi
