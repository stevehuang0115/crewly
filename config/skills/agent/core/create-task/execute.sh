#!/bin/bash
# Create a new task as a V3 WorkItem in the task-pool.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# the v1 `POST /task-management/create` endpoint, which wrote a `.md` file
# to the project's `.crewly/tasks/` filesystem. The V3 task-pool's
# `POST /task-pool/add` endpoint is now the sole way to create new tasks.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --project-path /path/to/project --task "Implement login API" \
    --priority high --milestone sprint-1 --session dev-1

  # Legacy JSON (backward compatible)
  bash execute.sh '{"projectPath":"/path/to/project","task":"Implement login API","priority":"high"}'

Options:
  --project-path | -p   Absolute path to the project root (required)
  --task         | -t   Task description (required)
  --priority            Priority level: low, medium, high, critical (default: medium)
  --milestone    | -m   Milestone/sprint name (default: delegated)
  --session      | -s   Session to assign the task to (optional; if omitted, task is open)
  --output-schema       JSON string defining expected output schema (optional)
  --json         | -j   Raw JSON payload (same as legacy)
  --help         | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
PROJECT_PATH=""
TASK=""
PRIORITY=""
MILESTONE=""
SESSION_NAME=""
OUTPUT_SCHEMA=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-path|-p)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --task|-t)
      TASK="$2"
      shift 2
      ;;
    --priority)
      PRIORITY="$2"
      shift 2
      ;;
    --milestone|-m)
      MILESTONE="$2"
      shift 2
      ;;
    --session|-s)
      SESSION_NAME="$2"
      shift 2
      ;;
    --output-schema)
      OUTPUT_SCHEMA="$2"
      shift 2
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

# Read from stdin if no input yet
if [ -z "$INPUT_JSON" ] && [ -z "$TASK" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ -z "$TASK" ] && TASK=$(printf '%s' "$INPUT" | jq -r '.task // empty')
  [ -z "$PRIORITY" ] && PRIORITY=$(printf '%s' "$INPUT" | jq -r '.priority // empty')
  [ -z "$MILESTONE" ] && MILESTONE=$(printf '%s' "$INPUT" | jq -r '.milestone // empty')
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
  [ -z "$OUTPUT_SCHEMA" ] && OUTPUT_SCHEMA=$(printf '%s' "$INPUT" | jq -c '.outputSchema // empty')
fi

# Apply defaults
PRIORITY="${PRIORITY:-medium}"
MILESTONE="${MILESTONE:-delegated}"

require_param "projectPath (--project-path)" "$PROJECT_PATH"
require_param "task (--task)" "$TASK"

# Build a V3 WorkItem for the task-pool.
# `addToPool` accepts the WorkItem directly (id auto-generated server-side
# when omitted). `priority` is mapped to V3's numeric priority scale where
# critical=1, high=2, medium=3, low=4 — lower number = higher priority.
case "$PRIORITY" in
  critical) PRIORITY_NUM=1 ;;
  high)     PRIORITY_NUM=2 ;;
  medium)   PRIORITY_NUM=3 ;;
  low)      PRIORITY_NUM=4 ;;
  *)        PRIORITY_NUM=3 ;;
esac

WI_ID="task-$(date +%s%N | cut -c1-13)-$$"

WORK_ITEM=$(jq -n \
  --arg id "$WI_ID" \
  --arg title "$TASK" \
  --arg target "$SESSION_NAME" \
  --arg owner "${SESSION_NAME:-system}" \
  --arg projectPath "$PROJECT_PATH" \
  --arg milestone "$MILESTONE" \
  --argjson priority "$PRIORITY_NUM" \
  '{
    id: $id,
    title: $title,
    type: "delegate",
    owner: $owner,
    priority: $priority,
    status: "queued",
    target: (if $target == "" then null else $target end),
    metadata: { projectPath: $projectPath, milestone: $milestone }
  } | with_entries(select(.value != null))')

if [ -n "$OUTPUT_SCHEMA" ] && [ "$OUTPUT_SCHEMA" != "" ]; then
  WORK_ITEM=$(printf '%s' "$WORK_ITEM" | jq --argjson schema "$OUTPUT_SCHEMA" '.metadata += {outputSchema: $schema}')
fi

BODY=$(jq -n --argjson workItem "$WORK_ITEM" '{workItem: $workItem}')

api_call POST "/task-pool/add" "$BODY"
