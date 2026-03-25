#!/bin/bash
# Analyze git changes and produce a structured code review
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"projectPath\":\"/path/to/project\",\"target\":\"staged\",\"branch\":\"main\"}'"

# Parse parameters
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // "."')
TARGET=$(printf '%s' "$INPUT" | jq -r '.target // "staged"')
BRANCH=$(printf '%s' "$INPUT" | jq -r '.branch // "main"')

# Validate project path has a git repo
if [ ! -d "$PROJECT_PATH/.git" ]; then
  error_exit "Not a git repository: $PROJECT_PATH"
fi

cd "$PROJECT_PATH"

# Get the diff based on target
case "$TARGET" in
  staged)
    DIFF=$(git diff --cached 2>/dev/null || echo "")
    DIFF_STAT=$(git diff --cached --stat 2>/dev/null || echo "")
    DIFF_NUMSTAT=$(git diff --cached --numstat 2>/dev/null || echo "")
    ;;
  unstaged)
    DIFF=$(git diff 2>/dev/null || echo "")
    DIFF_STAT=$(git diff --stat 2>/dev/null || echo "")
    DIFF_NUMSTAT=$(git diff --numstat 2>/dev/null || echo "")
    ;;
  last-commit)
    DIFF=$(git diff HEAD~1 2>/dev/null || echo "")
    DIFF_STAT=$(git diff HEAD~1 --stat 2>/dev/null || echo "")
    DIFF_NUMSTAT=$(git diff HEAD~1 --numstat 2>/dev/null || echo "")
    ;;
  branch)
    DIFF=$(git diff "${BRANCH}...HEAD" 2>/dev/null || echo "")
    DIFF_STAT=$(git diff "${BRANCH}...HEAD" --stat 2>/dev/null || echo "")
    DIFF_NUMSTAT=$(git diff "${BRANCH}...HEAD" --numstat 2>/dev/null || echo "")
    ;;
  *)
    error_exit "Invalid target: $TARGET. Must be one of: staged, unstaged, last-commit, branch"
    ;;
esac

if [ -z "$DIFF" ]; then
  jq -n \
    --arg target "$TARGET" \
    '{
      target: $target,
      filesReviewed: 0,
      stats: { insertions: 0, deletions: 0 },
      issues: [],
      summary: "No changes found for target: \($target)",
      passesReview: true
    }'
  exit 0
fi

# Count files changed
FILES_CHANGED=$(echo "$DIFF_NUMSTAT" | grep -c . 2>/dev/null || echo "0")

# Calculate total insertions and deletions
TOTAL_INSERTIONS=$(echo "$DIFF_NUMSTAT" | awk '{s+=$1} END {print s+0}' 2>/dev/null || echo "0")
TOTAL_DELETIONS=$(echo "$DIFF_NUMSTAT" | awk '{s+=$2} END {print s+0}' 2>/dev/null || echo "0")

# Get list of changed files
CHANGED_FILES=$(echo "$DIFF_NUMSTAT" | awk '{print $3}' 2>/dev/null || echo "")

# Initialize issues array
ISSUES="[]"

# Check 1: Files with no corresponding test file
while IFS= read -r file; do
  [ -z "$file" ] && continue
  # Only check .ts and .tsx source files (skip test files, configs, etc.)
  if echo "$file" | grep -qE '\.(ts|tsx)$' && ! echo "$file" | grep -qE '\.(test|spec|e2e)\.(ts|tsx)$'; then
    # Skip type definition files, configs, index files
    if echo "$file" | grep -qE '(\.d\.ts|config|constants)$'; then
      continue
    fi
    # Derive expected test file
    TEST_FILE=$(echo "$file" | sed 's/\.\(ts\|tsx\)$/.test.\1/')
    if [ ! -f "$TEST_FILE" ]; then
      ISSUES=$(echo "$ISSUES" | jq --arg file "$file" \
        '. + [{"type":"missing-test","file":$file,"severity":"warning","message":"No corresponding test file found"}]')
    fi
  fi
done <<< "$CHANGED_FILES"

# Check 2: console.log / debugger / TODO in added lines
ADDED_LINES=$(echo "$DIFF" | grep '^+' | grep -v '^+++' || echo "")

# console.log check
CONSOLE_MATCHES=$(echo "$ADDED_LINES" | grep -n 'console\.log\|console\.debug' 2>/dev/null || echo "")
if [ -n "$CONSOLE_MATCHES" ]; then
  ISSUES=$(echo "$ISSUES" | jq \
    '. + [{"type":"debug-statement","file":"(multiple)","severity":"error","message":"console.log/console.debug found in added code"}]')
fi

# debugger check
DEBUGGER_MATCHES=$(echo "$ADDED_LINES" | grep -n 'debugger' 2>/dev/null || echo "")
if [ -n "$DEBUGGER_MATCHES" ]; then
  ISSUES=$(echo "$ISSUES" | jq \
    '. + [{"type":"debug-statement","file":"(multiple)","severity":"error","message":"debugger statement found in added code"}]')
fi

# Check 3: Potential secrets in added lines
SECRET_MATCHES=$(echo "$ADDED_LINES" | grep -iE '(api_key|api[-_]?secret|password|token|secret_key|private_key)[[:space:]]*[=:]' 2>/dev/null || echo "")
if [ -n "$SECRET_MATCHES" ]; then
  ISSUES=$(echo "$ISSUES" | jq \
    '. + [{"type":"potential-secret","file":"(multiple)","severity":"critical","message":"Possible secret/credential pattern detected in added code"}]')
fi

# Check 4: Large file changes (>300 lines)
while IFS= read -r line; do
  [ -z "$line" ] && continue
  INSERTIONS=$(echo "$line" | awk '{print $1}')
  FILE=$(echo "$line" | awk '{print $3}')
  if [ "$INSERTIONS" != "-" ] && [ "$INSERTIONS" -gt 300 ] 2>/dev/null; then
    ISSUES=$(echo "$ISSUES" | jq --arg file "$FILE" --arg lines "$INSERTIONS" \
      '. + [{"type":"large-change","file":$file,"severity":"warning","message":"Large file change: \($lines) lines added"}]')
  fi
done <<< "$DIFF_NUMSTAT"

# Check 5: package.json changes (new dependencies)
if echo "$CHANGED_FILES" | grep -q 'package.json'; then
  ISSUES=$(echo "$ISSUES" | jq \
    '. + [{"type":"dependency-change","file":"package.json","severity":"info","message":"package.json modified — review new dependencies"}]')
fi

# Count issues by severity
CRITICAL_COUNT=$(echo "$ISSUES" | jq '[.[] | select(.severity == "critical")] | length')
ERROR_COUNT=$(echo "$ISSUES" | jq '[.[] | select(.severity == "error")] | length')
WARNING_COUNT=$(echo "$ISSUES" | jq '[.[] | select(.severity == "warning")] | length')
INFO_COUNT=$(echo "$ISSUES" | jq '[.[] | select(.severity == "info")] | length')
TOTAL_ISSUES=$(echo "$ISSUES" | jq 'length')

# Determine if review passes (no critical or error issues)
PASSES="true"
if [ "$CRITICAL_COUNT" -gt 0 ] || [ "$ERROR_COUNT" -gt 0 ]; then
  PASSES="false"
fi

# Build summary
SUMMARY="${FILES_CHANGED} files reviewed."
[ "$CRITICAL_COUNT" -gt 0 ] && SUMMARY+=" ${CRITICAL_COUNT} critical."
[ "$ERROR_COUNT" -gt 0 ] && SUMMARY+=" ${ERROR_COUNT} error(s)."
[ "$WARNING_COUNT" -gt 0 ] && SUMMARY+=" ${WARNING_COUNT} warning(s)."
[ "$INFO_COUNT" -gt 0 ] && SUMMARY+=" ${INFO_COUNT} info."
[ "$TOTAL_ISSUES" -eq 0 ] && SUMMARY+=" No issues found."

# Output JSON
jq -n \
  --arg target "$TARGET" \
  --arg filesReviewed "$FILES_CHANGED" \
  --arg insertions "$TOTAL_INSERTIONS" \
  --arg deletions "$TOTAL_DELETIONS" \
  --argjson issues "$ISSUES" \
  --arg summary "$SUMMARY" \
  --arg passesReview "$PASSES" \
  '{
    target: $target,
    filesReviewed: ($filesReviewed | tonumber),
    stats: {
      insertions: ($insertions | tonumber),
      deletions: ($deletions | tonumber)
    },
    issues: $issues,
    summary: $summary,
    passesReview: ($passesReview == "true")
  }'
