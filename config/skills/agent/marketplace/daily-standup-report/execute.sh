#!/bin/bash
# Generate a daily standup report from git activity and task status
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"projectPath\":\"/path/to/project\",\"days\":1,\"author\":\"\",\"includeTaskStatus\":true}'"

# Parse parameters
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // "."')
DAYS=$(printf '%s' "$INPUT" | jq -r '.days // 1')
AUTHOR=$(printf '%s' "$INPUT" | jq -r '.author // empty')
INCLUDE_TASKS=$(printf '%s' "$INPUT" | jq -r '.includeTaskStatus // true')

# Validate project path has a git repo
if [ ! -d "$PROJECT_PATH/.git" ]; then
  error_exit "Not a git repository: $PROJECT_PATH"
fi

cd "$PROJECT_PATH"

TODAY=$(date +%Y-%m-%d)

# Build git log command
GIT_LOG_ARGS=(--since="${DAYS} days ago" --pretty=format:"%s" --no-merges)
[ -n "${AUTHOR:-}" ] && GIT_LOG_ARGS+=(--author="$AUTHOR")

# Gather git commits
COMMITS=$(git log "${GIT_LOG_ARGS[@]}" 2>/dev/null || echo "")
COMMIT_COUNT=$(echo "$COMMITS" | grep -c . 2>/dev/null || echo "0")

# Gather git stats using diffstat
DIFF_STAT=$(git diff --shortstat "HEAD@{${DAYS} days ago}" 2>/dev/null || git diff --shortstat HEAD~"${COMMIT_COUNT}" 2>/dev/null || echo "")
FILES_CHANGED=$(echo "$DIFF_STAT" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo "0")
INSERTIONS=$(echo "$DIFF_STAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
DELETIONS=$(echo "$DIFF_STAT" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")

# Build done array from commits
DONE_JSON="[]"
if [ -n "$COMMITS" ] && [ "$COMMITS" != "" ]; then
  DONE_JSON=$(echo "$COMMITS" | jq -R -s 'split("\n") | map(select(length > 0))')
fi

# Gather task status if requested
PLANNED_JSON="[]"
BLOCKERS_JSON="[]"
if [ "$INCLUDE_TASKS" = "true" ]; then
  # V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
  # Replaces `GET /task-management/tasks` with the V3 task-pool list.
  TASKS_RESPONSE=$(api_call GET "/task-pool/items" 2>/dev/null || echo "")
  if [ -n "$TASKS_RESPONSE" ]; then
    PLANNED_JSON=$(echo "$TASKS_RESPONSE" | jq '[(.data // .workItems // [])[] | select(.status == "running" or .status == "queued") | "Task: \(.title // "Untitled") (\(.status))"] // []' 2>/dev/null || echo "[]")
    BLOCKERS_JSON=$(echo "$TASKS_RESPONSE" | jq '[(.data // .workItems // [])[] | select(.status == "blocked") | "Task: \(.title // "Untitled") (blocked)"] // []' 2>/dev/null || echo "[]")
  fi
fi

# Build markdown report
REPORT="## Daily Standup — ${TODAY}\n\n"
REPORT+="### Done (last ${DAYS} day(s))\n"
if [ "$COMMIT_COUNT" -gt 0 ] 2>/dev/null; then
  while IFS= read -r line; do
    [ -n "$line" ] && REPORT+="- ${line}\n"
  done <<< "$COMMITS"
else
  REPORT+="- No commits in the last ${DAYS} day(s)\n"
fi

REPORT+="\n### Planned\n"
PLANNED_COUNT=$(echo "$PLANNED_JSON" | jq 'length' 2>/dev/null || echo "0")
if [ "$PLANNED_COUNT" -gt 0 ] 2>/dev/null; then
  for i in $(seq 0 $((PLANNED_COUNT - 1))); do
    ITEM=$(echo "$PLANNED_JSON" | jq -r ".[$i]")
    REPORT+="- ${ITEM}\n"
  done
else
  REPORT+="- No active tasks found\n"
fi

REPORT+="\n### Blockers\n"
BLOCKER_COUNT=$(echo "$BLOCKERS_JSON" | jq 'length' 2>/dev/null || echo "0")
if [ "$BLOCKER_COUNT" -gt 0 ] 2>/dev/null; then
  for i in $(seq 0 $((BLOCKER_COUNT - 1))); do
    ITEM=$(echo "$BLOCKERS_JSON" | jq -r ".[$i]")
    REPORT+="- ${ITEM}\n"
  done
else
  REPORT+="- None\n"
fi

REPORT+="\n### Stats\n"
REPORT+="- Commits: ${COMMIT_COUNT}\n"
REPORT+="- Files changed: ${FILES_CHANGED}\n"
REPORT+="- Insertions: +${INSERTIONS}\n"
REPORT+="- Deletions: -${DELETIONS}\n"

# Output JSON
jq -n \
  --arg date "$TODAY" \
  --arg period "last ${DAYS} day(s)" \
  --argjson done "$DONE_JSON" \
  --argjson planned "$PLANNED_JSON" \
  --argjson blockers "$BLOCKERS_JSON" \
  --arg commits "$COMMIT_COUNT" \
  --arg filesChanged "$FILES_CHANGED" \
  --arg insertions "$INSERTIONS" \
  --arg deletions "$DELETIONS" \
  --arg report "$REPORT" \
  '{
    date: $date,
    period: $period,
    done: $done,
    planned: $planned,
    blockers: $blockers,
    stats: {
      commits: ($commits | tonumber),
      filesChanged: ($filesChanged | tonumber),
      insertions: ($insertions | tonumber),
      deletions: ($deletions | tonumber)
    },
    report: $report
  }'
