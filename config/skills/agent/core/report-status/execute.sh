#!/bin/bash
# Report task status to the orchestrator
# Supports both CLI flags (preferred) and legacy JSON argument.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred — avoids shell escaping issues)
  bash execute.sh --session dev-1 --status done --summary "Fixed the bug" --project /path/to/project

  # Summary from stdin (for multi-line or special characters)
  echo "Fixed the bug — it's working" | bash execute.sh --session dev-1 --status done --project /path

  # Summary from file
  bash execute.sh --session dev-1 --status done --summary-file /tmp/summary.txt --project /path

  # Legacy JSON argument (backward compatible)
  bash execute.sh '{"sessionName":"dev-1","status":"done","summary":"Fixed the bug"}'

Options:
  --session  | -s   Agent session name (required)
  --status   | -S   Status: done, blocked, failed, in_progress, active (required)
  --summary  | -m   Status summary text (required unless piped via stdin)
  --summary-file    Read summary from file path
  --project  | -p   Project path for auto-remember on completion
  --task-path       Task file path to auto-complete
  --task-id         Task ID (for structured StatusReport format)
  --progress        Progress percentage (0-100, for structured format)
  --structured      Use structured StatusReport format (true/false)
  --json     | -j   Raw JSON payload (same as legacy)
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
STATUS=""
SUMMARY=""
PROJECT_PATH=""
TASK_PATH=""
TASK_ID=""
PROGRESS=""
STRUCTURED="false"

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session|-s)
      SESSION_NAME="$2"
      shift 2
      ;;
    --status|-S)
      STATUS="$2"
      shift 2
      ;;
    --summary|-m)
      SUMMARY="$2"
      shift 2
      ;;
    --summary-file)
      SUMMARY="$(cat "$2")"
      shift 2
      ;;
    --project|-p)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --task-path)
      TASK_PATH="$2"
      shift 2
      ;;
    --task-id)
      TASK_ID="$2"
      shift 2
      ;;
    --progress)
      PROGRESS="$2"
      shift 2
      ;;
    --structured)
      STRUCTURED="true"
      shift
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"
        shift
      else
        error_exit "Unknown argument: $1. Use --help for usage."
      fi
      ;;
  esac
done

# If nothing provided yet but stdin has data, read it as summary
if [ -z "$INPUT_JSON" ] && [ -z "$SUMMARY" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    SUMMARY="$STDIN_DATA"
  fi
fi

# Parse JSON input if provided (backward compatible)
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
  [ -z "$STATUS" ] && STATUS=$(printf '%s' "$INPUT" | jq -r '.status // empty')
  [ -z "$SUMMARY" ] && SUMMARY=$(printf '%s' "$INPUT" | jq -r '.summary // empty')
  [ -z "$TASK_PATH" ] && TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.taskPath // empty')
  [ -z "$TASK_ID" ] && TASK_ID=$(printf '%s' "$INPUT" | jq -r '.taskId // empty')
  [ -z "$PROGRESS" ] && PROGRESS=$(printf '%s' "$INPUT" | jq -r '.progress // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  ARTIFACTS=$(printf '%s' "$INPUT" | jq -c '.artifacts // empty')
  BLOCKERS=$(printf '%s' "$INPUT" | jq -c '.blockers // empty')
  USE_STRUCTURED=$(printf '%s' "$INPUT" | jq -r '.structured // "false"')
  [ "$USE_STRUCTURED" = "true" ] && STRUCTURED="true"
else
  ARTIFACTS=""
  BLOCKERS=""
fi

require_param "sessionName (--session)" "$SESSION_NAME"
require_param "status (--status)" "$STATUS"
require_param "summary (--summary)" "$SUMMARY"

# Gate: before_mark_done — reject empty or trivially short summaries
# This prevents agents from marking tasks done without meaningful output.
if [ "$STATUS" = "done" ]; then
  SUMMARY_LEN=${#SUMMARY}
  if [ "$SUMMARY_LEN" -lt 20 ]; then
    echo "{\"error\":\"before_mark_done gate failed: summary too short (${SUMMARY_LEN} chars, minimum 20). Provide a meaningful summary of what was accomplished.\"}" >&2
    error_exit "Summary must be at least 20 characters when reporting done (got ${SUMMARY_LEN})"
  fi
fi

# Map simple status strings to InProgressTaskStatus values
map_status_to_state() {
  case "$1" in
    done|completed) echo "completed" ;;
    blocked) echo "blocked" ;;
    failed) echo "failed" ;;
    in_progress|working) echo "working" ;;
    *) echo "$1" ;;
  esac
}

# Build the message the orchestrator will receive
if [ "$STRUCTURED" = "true" ] && [ -n "$TASK_ID" ]; then
  # Structured StatusReport format for hierarchical teams
  STATE=$(map_status_to_state "$STATUS")
  MESSAGE="---\n[STATUS REPORT]\nTask ID: ${TASK_ID}\nState: ${STATE}"
  [ -n "$PROGRESS" ] && MESSAGE="${MESSAGE}\nProgress: ${PROGRESS}%"
  MESSAGE="${MESSAGE}\nReported by: ${SESSION_NAME}\n---\n\n## Status\n${SUMMARY}"

  # Add artifacts if provided
  if [ -n "$ARTIFACTS" ] && [ "$ARTIFACTS" != "" ]; then
    ARTIFACT_LINES=$(printf '%s' "$ARTIFACTS" | jq -r '.[]? | "- **\(.name)** (\(.type)): \(.content)"' 2>/dev/null || true)
    if [ -n "$ARTIFACT_LINES" ]; then
      MESSAGE="${MESSAGE}\n\n## Artifacts\n${ARTIFACT_LINES}"
    fi
  fi

  # Add blockers if provided
  if [ -n "$BLOCKERS" ] && [ "$BLOCKERS" != "" ]; then
    BLOCKER_LINES=$(printf '%s' "$BLOCKERS" | jq -r '.[]? // empty' 2>/dev/null | while read -r b; do printf '%s\n' "- ${b}"; done)
    if [ -n "$BLOCKER_LINES" ]; then
      MESSAGE="${MESSAGE}\n\n## Blockers\n${BLOCKER_LINES}"
    fi
  fi
else
  # Legacy format (backwards compatible)
  STATUS_UPPER=$(echo "$STATUS" | tr '[:lower:]' '[:upper:]')
  MESSAGE="[${STATUS_UPPER}] Agent ${SESSION_NAME}: ${SUMMARY}"
fi

# Send the status message to the orchestrator session via the chat API
BODY=$(jq -n --arg content "$MESSAGE" --arg senderName "$SESSION_NAME" \
  '{content: $content, senderName: $senderName, senderType: "agent"}')

api_call POST "/chat/agent-response" "$BODY"

# If task is done and taskPath provided, move task file to done folder
if [ "$STATUS" = "done" ] && [ -n "$TASK_PATH" ]; then
  COMPLETE_BODY=$(jq -n \
    --arg taskPath "$TASK_PATH" \
    --arg sessionName "$SESSION_NAME" \
    '{taskPath: $taskPath, sessionName: $sessionName}')
  api_call POST "/task-management/complete" "$COMPLETE_BODY" || true
fi

# Auto-complete tracked tasks when status is done
if [ "$STATUS" = "done" ]; then
  SESSION_BODY=$(jq -n --arg sessionName "$SESSION_NAME" '{sessionName: $sessionName}')
  api_call POST "/task-management/complete-by-session" "$SESSION_BODY" || true
fi

# Auto-persist key findings as project knowledge when task is done (#127, #219).
if [ "$STATUS" = "done" ] && [ -n "$SUMMARY" ]; then
  auto_remember "$SESSION_NAME" "[COMPLETED] Task completed by ${SESSION_NAME}: ${SUMMARY}" "decision" "project" "$PROJECT_PATH"
fi

# Growth: record learning and extract growth areas on task completion.
# Uses existing APIs — no additional LLM calls. The agent's own summary
# is the learning input; keyword extraction identifies growth areas.
if [ "$STATUS" = "done" ] && [ -n "$SUMMARY" ] && [ -n "$PROJECT_PATH" ]; then
  # Record as a structured learning entry (appends to what_worked.md)
  LEARN_BODY=$(jq -n \
    --arg agentId "$SESSION_NAME" \
    --arg content "$SUMMARY" \
    --arg projectPath "$PROJECT_PATH" \
    --arg type "success" \
    '{agentId: $agentId, content: $content, projectPath: $projectPath, type: $type}')
  api_call POST "/memory/record-learning" "$LEARN_BODY" 2>/dev/null || true

  # Extract growth areas from summary (keyword-based, no LLM)
  GROWTH_BODY=$(jq -n \
    --arg sessionName "$SESSION_NAME" \
    --arg text "$SUMMARY" \
    '{sessionName: $sessionName, text: $text}')
  api_call POST "/growth/extract-areas" "$GROWTH_BODY" 2>/dev/null || true
fi

# Growth: record failures for learning when task fails or is blocked.
if [ "$STATUS" = "failed" ] || [ "$STATUS" = "blocked" ]; then
  if [ -n "$SUMMARY" ] && [ -n "$PROJECT_PATH" ]; then
    FAIL_BODY=$(jq -n \
      --arg agentId "$SESSION_NAME" \
      --arg content "$SUMMARY" \
      --arg projectPath "$PROJECT_PATH" \
      --arg type "failure" \
      '{agentId: $agentId, content: $content, projectPath: $projectPath, type: $type}')
    api_call POST "/memory/record-learning" "$FAIL_BODY" 2>/dev/null || true
  fi
fi
