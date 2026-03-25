#!/bin/bash
# Aggregate results from worker sub-tasks into a structured markdown report.
# Fetches task data from the task-management API and compiles a report.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"teamId\":\"team-123\",\"objective\":\"Build auth module\",\"reportType\":\"final\",\"taskPaths\":[\"/path/to/task1.md\",\"/path/to/task2.md\"],\"projectPath\":\"/path/to/project\"}'"

TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
OBJECTIVE=$(printf '%s' "$INPUT" | jq -r '.objective // "Objective not specified"')
REPORT_TYPE=$(printf '%s' "$INPUT" | jq -r '.reportType // "final"')
TASK_PATHS=$(printf '%s' "$INPUT" | jq -c '.taskPaths // []')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
INCLUDE_VERIFICATION=$(printf '%s' "$INPUT" | jq -r '.includeVerification // "true"')

# Collect task data
TASK_RESULTS="[]"
SUCCESS_COUNT=0
FAILURE_COUNT=0
BLOCKED_COUNT=0
PENDING_COUNT=0

TASK_COUNT=$(echo "$TASK_PATHS" | jq 'length')

# If task paths provided, read each task
if [ "$TASK_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((TASK_COUNT - 1))); do
    TASK_PATH=$(echo "$TASK_PATHS" | jq -r ".[$i]")
    READ_BODY=$(jq -n --arg taskPath "$TASK_PATH" '{taskPath: $taskPath}')
    TASK_DATA=$(api_call POST "/task-management/read-task" "$READ_BODY" 2>/dev/null || echo '{}')

    TASK_STATUS=$(echo "$TASK_DATA" | jq -r '.data.metadata.status // "unknown"' 2>/dev/null || echo "unknown")
    TASK_TITLE=$(echo "$TASK_DATA" | jq -r '.data.metadata.title // .data.metadata.task // "Untitled"' 2>/dev/null || echo "Untitled")
    TASK_ASSIGNEE=$(echo "$TASK_DATA" | jq -r '.data.metadata.assignedTo // "unassigned"' 2>/dev/null || echo "unassigned")
    TASK_SUMMARY=$(echo "$TASK_DATA" | jq -r '.data.metadata.summary // ""' 2>/dev/null || true)

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
      --arg summary "$TASK_SUMMARY" \
      --arg path "$TASK_PATH" \
      '. + [{title: $title, status: $status, assignee: $assignee, summary: $summary, path: $path}]')
  done
fi

# If no task paths but teamId provided, get team progress
if [ "$TASK_COUNT" = "0" ] && [ -n "$PROJECT_PATH" ]; then
  PROGRESS_DATA=$(api_call GET "/task-management/team-progress?projectPath=${PROJECT_PATH}" 2>/dev/null || echo '{}')
  # Extract counts from team progress if available
  SUCCESS_COUNT=$(echo "$PROGRESS_DATA" | jq -r '.data.done // 0' 2>/dev/null || echo "0")
  FAILURE_COUNT=$(echo "$PROGRESS_DATA" | jq -r '.data.failed // 0' 2>/dev/null || echo "0")
  BLOCKED_COUNT=$(echo "$PROGRESS_DATA" | jq -r '.data.blocked // 0' 2>/dev/null || echo "0")
  PENDING_COUNT=$(echo "$PROGRESS_DATA" | jq -r '.data.open // 0' 2>/dev/null || echo "0")
fi

TOTAL=$((SUCCESS_COUNT + FAILURE_COUNT + BLOCKED_COUNT + PENDING_COUNT))

# Generate the report
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
REPORT_TITLE=""
case "$REPORT_TYPE" in
  milestone) REPORT_TITLE="Milestone Report" ;;
  daily) REPORT_TITLE="Daily Progress Report" ;;
  final) REPORT_TITLE="Final Completion Report" ;;
  *) REPORT_TITLE="Progress Report" ;;
esac

# Build markdown report
REPORT="[TL_REPORT]

# ${REPORT_TITLE}

**Objective**: ${OBJECTIVE}
**Report Type**: ${REPORT_TYPE}
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

**Completion Rate**: $([ "$TOTAL" -gt 0 ] && echo "$((SUCCESS_COUNT * 100 / TOTAL))%" || echo "N/A")
"

# Add individual task details if available
RESULT_COUNT=$(echo "$TASK_RESULTS" | jq 'length')
if [ "$RESULT_COUNT" -gt 0 ]; then
  REPORT="${REPORT}
## Task Details
"
  for i in $(seq 0 $((RESULT_COUNT - 1))); do
    T_TITLE=$(echo "$TASK_RESULTS" | jq -r ".[$i].title")
    T_STATUS=$(echo "$TASK_RESULTS" | jq -r ".[$i].status")
    T_ASSIGNEE=$(echo "$TASK_RESULTS" | jq -r ".[$i].assignee")
    T_SUMMARY=$(echo "$TASK_RESULTS" | jq -r ".[$i].summary")

    # Status emoji
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
$([ -n "$T_SUMMARY" ] && echo "- **Summary**: ${T_SUMMARY}" || true)
"
  done
fi

# Add action items for non-complete items
if [ "$FAILURE_COUNT" -gt 0 ] || [ "$BLOCKED_COUNT" -gt 0 ]; then
  REPORT="${REPORT}
## Action Items

$([ "$FAILURE_COUNT" -gt 0 ] && echo "- ${FAILURE_COUNT} task(s) failed — review via handle-failure skill" || true)
$([ "$BLOCKED_COUNT" -gt 0 ] && echo "- ${BLOCKED_COUNT} task(s) blocked — escalate to Orchestrator if unresolvable" || true)
"
fi

# Write report to temp file for reliable output
REPORT_FILE="/tmp/tl-report-${TEAM_ID:-unknown}-$(date +%s).md"
echo "$REPORT" > "$REPORT_FILE"

# Output JSON result
jq -n \
  --arg reportType "$REPORT_TYPE" \
  --arg objective "$OBJECTIVE" \
  --arg reportFile "$REPORT_FILE" \
  --arg timestamp "$TIMESTAMP" \
  --arg total "$TOTAL" \
  --arg success "$SUCCESS_COUNT" \
  --arg failed "$FAILURE_COUNT" \
  --arg blocked "$BLOCKED_COUNT" \
  --arg pending "$PENDING_COUNT" \
  '{
    success: true,
    reportType: $reportType,
    objective: $objective,
    reportFile: $reportFile,
    timestamp: $timestamp,
    stats: {
      total: ($total | tonumber),
      completed: ($success | tonumber),
      failed: ($failed | tonumber),
      blocked: ($blocked | tonumber),
      pending: ($pending | tonumber)
    }
  }'
