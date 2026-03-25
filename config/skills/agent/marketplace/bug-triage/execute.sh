#!/bin/bash
# Triage a bug report by searching the codebase for related files
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"title\":\"Bug title\",\"description\":\"Bug description\",\"projectPath\":\"/path/to/project\",\"keywords\":\"login,auth\"}'"

# Parse parameters
TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
DESCRIPTION=$(printf '%s' "$INPUT" | jq -r '.description // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // "."')
KEYWORDS_INPUT=$(printf '%s' "$INPUT" | jq -r '.keywords // empty')

require_param "title" "$TITLE"
require_param "description" "$DESCRIPTION"

cd "$PROJECT_PATH"

# Extract keywords from title + description if not provided
if [ -n "$KEYWORDS_INPUT" ]; then
  # Use provided keywords (comma-separated)
  IFS=',' read -ra KEYWORDS <<< "$KEYWORDS_INPUT"
else
  # Extract meaningful words from title and description (4+ chars, lowercase)
  COMBINED="${TITLE} ${DESCRIPTION}"
  KEYWORDS=()
  for word in $(echo "$COMBINED" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '\n' | sort -u); do
    # Skip short words and common stop words
    if [ ${#word} -ge 4 ] && ! echo "$word" | grep -qE '^(this|that|with|from|have|been|when|what|they|will|would|could|should|also|just|then|than|into|some|more|very|only|does|each|much|most|such|here|there|where|about|after|before|other|these|those|being|first|which|their|over|your|were|said|like|many|make|take|come|find)$'; then
      KEYWORDS+=("$word")
    fi
  done
fi

# Limit to 10 keywords max
KEYWORDS=("${KEYWORDS[@]:0:10}")

# Search codebase for matching files
RELATED_FILES="[]"
for keyword in "${KEYWORDS[@]}"; do
  keyword=$(echo "$keyword" | xargs)  # trim whitespace
  [ -z "$keyword" ] && continue
  # Search for keyword in source files, skip node_modules/dist/etc
  MATCHES=$(grep -rl --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.css' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=coverage \
    "$keyword" . 2>/dev/null | head -20 || echo "")
  if [ -n "$MATCHES" ]; then
    while IFS= read -r file; do
      [ -z "$file" ] && continue
      # Remove leading ./
      file="${file#./}"
      RELATED_FILES=$(echo "$RELATED_FILES" | jq --arg f "$file" 'if (. | index($f)) then . else . + [$f] end')
    done <<< "$MATCHES"
  fi
done

# Limit related files to top 10
RELATED_FILES=$(echo "$RELATED_FILES" | jq '.[0:10]')

# Classify affected area based on file patterns
FRONTEND_COUNT=$(echo "$RELATED_FILES" | jq '[.[] | select(test("\\.(tsx|css|scss|jsx)$") or test("frontend/|components/|pages/"))] | length')
BACKEND_COUNT=$(echo "$RELATED_FILES" | jq '[.[] | select(test("services/|controllers/|routes/|backend/") and (test("\\.(tsx|jsx)$") | not))] | length')
CONFIG_COUNT=$(echo "$RELATED_FILES" | jq '[.[] | select(test("config/|constants|\\.(json|yml|yaml)$"))] | length')
TEST_COUNT=$(echo "$RELATED_FILES" | jq '[.[] | select(test("\\.(test|spec)\\."))] | length')

AFFECTED_AREA="unknown"
if [ "$FRONTEND_COUNT" -gt "$BACKEND_COUNT" ] 2>/dev/null; then
  AFFECTED_AREA="frontend"
elif [ "$BACKEND_COUNT" -gt 0 ] 2>/dev/null; then
  AFFECTED_AREA="backend"
elif [ "$CONFIG_COUNT" -gt 0 ] 2>/dev/null; then
  AFFECTED_AREA="config"
elif [ "$TEST_COUNT" -gt 0 ] 2>/dev/null; then
  AFFECTED_AREA="tests"
fi

# Determine severity from keywords in title + description
COMBINED_LOWER=$(echo "${TITLE} ${DESCRIPTION}" | tr '[:upper:]' '[:lower:]')
SEVERITY="medium"
PRIORITY="P2"

# Critical keywords
if echo "$COMBINED_LOWER" | grep -qE '(crash|data.?loss|security|vulnerab|exploit|injection|breach|corrupt)'; then
  SEVERITY="critical"
  PRIORITY="P0"
# High keywords
elif echo "$COMBINED_LOWER" | grep -qE '(error|broken|fails|failure|exception|cannot|unable|blocked|down|outage)'; then
  SEVERITY="high"
  PRIORITY="P1"
# Low keywords
elif echo "$COMBINED_LOWER" | grep -qE '(slow|ugly|minor|cosmetic|typo|alignment|spacing|font|color|style|nice.?to.?have)'; then
  SEVERITY="low"
  PRIORITY="P3"
fi

# Suggest assignee based on affected area
SUGGESTED_ASSIGNEE="developer"
case "$AFFECTED_AREA" in
  frontend) SUGGESTED_ASSIGNEE="frontend-developer" ;;
  backend) SUGGESTED_ASSIGNEE="backend-developer" ;;
  config) SUGGESTED_ASSIGNEE="developer" ;;
  tests) SUGGESTED_ASSIGNEE="qa-engineer" ;;
esac

# Build keywords JSON array
KEYWORDS_JSON=$(printf '%s\n' "${KEYWORDS[@]}" | jq -R . | jq -s '.')

# Capitalize severity for display
SEVERITY_DISPLAY=$(echo "$SEVERITY" | awk '{print toupper(substr($0,1,1)) tolower(substr($0,2))}')

# Output JSON
jq -n \
  --arg title "$TITLE" \
  --arg severity "$SEVERITY" \
  --arg priority "$PRIORITY" \
  --arg affectedArea "$AFFECTED_AREA" \
  --argjson relatedFiles "$RELATED_FILES" \
  --arg suggestedAssignee "$SUGGESTED_ASSIGNEE" \
  --argjson keywords "$KEYWORDS_JSON" \
  --arg triage "${SEVERITY_DISPLAY} severity ${AFFECTED_AREA} issue. Assign to ${SUGGESTED_ASSIGNEE} for investigation." \
  '{
    title: $title,
    severity: $severity,
    priority: $priority,
    affectedArea: $affectedArea,
    relatedFiles: $relatedFiles,
    suggestedAssignee: $suggestedAssignee,
    keywords: $keywords,
    triage: $triage
  }'
