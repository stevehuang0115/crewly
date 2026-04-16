#!/bin/bash
# Aggregate results from worker sub-tasks into a structured markdown report.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"team-123\",\"objective\":\"...\",\"taskPaths\":[\"...\"]}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
OBJECTIVE=$(printf '%s' "$INPUT" | jq -r '.objective // "Objective not specified"')
REPORT_TYPE=$(printf '%s' "$INPUT" | jq -r '.reportType // "final"')
TASK_PATHS=$(printf '%s' "$INPUT" | jq -c '.taskPaths // []')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

TASK_RESULTS="[]"
SUCCESS_COUNT=0
FAILURE_COUNT=0
BLOCKED_COUNT=0
PENDING_COUNT=0

TASK_COUNT=$(echo "$TASK_PATHS" | jq 'length')

if [ "$TASK_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((TASK_COUNT - 1))); do
    TASK_PATH=$(echo "$TASK_PATHS" | jq -r ".[$i]")
    
    if [ -f "$TASK_PATH" ]; then
      CONTENT=$(cat "$TASK_PATH")
      # Parse title
      TASK_TITLE=$(echo "$CONTENT" | grep "^# " | head -1 | sed 's/^# //' | xargs || echo "Untitled")
      # Parse status
      TASK_STATUS=$(echo "$CONTENT" | grep -oE "\*\*Status\*\*: .*" | head -1 | cut -d: -f2 | xargs | tr '[:upper:]' '[:lower:]' || echo "unknown")
      # Parse assignee
      TASK_ASSIGNEE=$(echo "$CONTENT" | grep -oE "\*\*Assigned to\*\*: .*" | head -1 | cut -d: -f2 | xargs || echo "unassigned")
    else
      TASK_TITLE="Missing File"
      TASK_STATUS="unknown"
      TASK_ASSIGNEE="n/a"
    fi

    case "$TASK_STATUS" in
      done|completed) SUCCESS_COUNT=$((SUCCESS_COUNT + 1)) ;;
      blocked) BLOCKED_COUNT=$((BLOCKED_COUNT + 1)) ;;
      failed) FAILURE_COUNT=$((FAILURE_COUNT + 1)) ;;
      *) PENDING_COUNT=$((PENDING_COUNT + 1)) ;;
    esac

    TASK_RESULTS=$(echo "$TASK_RESULTS" | jq \
      --arg title "$TASK_TITLE" \
      --arg status "$TASK_STATUS" \
      --arg assignee "$TASK_ASSIGNEE" \
      --arg path "$TASK_PATH" \
      '. + [{title: $title, status: $status, assignee: $assignee, path: $path}]')
  done
fi

TOTAL=$((SUCCESS_COUNT + FAILURE_COUNT + BLOCKED_COUNT + PENDING_COUNT))
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
REPORT_TITLE="Final Completion Report"

REPORT="[TL_REPORT]

# ${REPORT_TITLE}

**Objective**: ${OBJECTIVE}
**Generated**: ${TIMESTAMP}
**Team**: ${TEAM_ID:-N/A}

## Summary

| Metric | Count |
|--------|-------|
| Total Tasks | ${TOTAL} |
| Completed | ${SUCCESS_COUNT} |
| Failed | ${FAILURE_COUNT} |
| Blocked | ${BLOCKED_COUNT} |
| Pending | ${PENDING_COUNT} |

**Completion Rate**: $([ "$TOTAL" -gt 0 ] && echo "$((SUCCESS_COUNT * 100 / TOTAL))%" || echo "0%")

## Task Details
"

RESULT_COUNT=$(echo "$TASK_RESULTS" | jq 'length')
for i in $(seq 0 $((RESULT_COUNT - 1))); do
    T_TITLE=$(echo "$TASK_RESULTS" | jq -r ".[$i].title")
    T_STATUS=$(echo "$TASK_RESULTS" | jq -r ".[$i].status")
    T_ASSIGNEE=$(echo "$TASK_RESULTS" | jq -r ".[$i].assignee")

    case "$T_STATUS" in
      done|completed) STATUS_MARK="DONE" ;;
      blocked) STATUS_MARK="BLOCKED" ;;
      failed) STATUS_MARK="FAILED" ;;
      *) STATUS_MARK="PENDING" ;;
    esac

    REPORT="${REPORT}
### [${STATUS_MARK}] ${T_TITLE}
- **Assignee**: ${T_ASSIGNEE}
- **Status**: ${T_STATUS}
"
done

REPORT_FILE="/tmp/tl-report-${TEAM_ID:-unknown}-$(date +%s).md"
echo "$REPORT" > "$REPORT_FILE"

jq -n \
  --arg reportFile "$REPORT_FILE" \
  --arg success "$SUCCESS_COUNT" \
  --arg total "$TOTAL" \
  '{
    success: true,
    reportFile: $reportFile,
    stats: {
      total: ($total | tonumber),
      completed: ($success | tonumber)
    }
  }'
