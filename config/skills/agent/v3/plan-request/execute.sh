#!/bin/bash
# Plan a user request into proposed ProjectTasks via the V3 Request Plan API.
# Allows agents to decompose a user message into structured, actionable tasks.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --message "Build a new auth system with OAuth2 support"
  bash execute.sh --message "Fix failing tests" --max-tasks 10 --default-priority high

  # Legacy JSON (backward compatible)
  bash execute.sh '{"message":"Build a search feature","options":{"maxTasks":5,"defaultPriority":"medium"}}'

Options:
  --message          | -m   The user request message to decompose (required)
  --max-tasks              Maximum number of tasks to generate (optional)
  --default-priority       Default priority: high, medium, low (optional)
  --json             | -j   Raw JSON payload (same as legacy)
  --help             | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
MESSAGE=""
MAX_TASKS=""
DEFAULT_PRIORITY=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --message|-m)
      MESSAGE="$2"
      shift 2
      ;;
    --max-tasks)
      MAX_TASKS="$2"
      shift 2
      ;;
    --default-priority)
      DEFAULT_PRIORITY="$2"
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
if [ -z "$INPUT_JSON" ] && [ -z "$MESSAGE" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$MESSAGE" ] && MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
  [ -z "$MAX_TASKS" ] && MAX_TASKS=$(printf '%s' "$INPUT" | jq -r '.options.maxTasks // empty')
  [ -z "$DEFAULT_PRIORITY" ] && DEFAULT_PRIORITY=$(printf '%s' "$INPUT" | jq -r '.options.defaultPriority // empty')
fi

require_param "message (--message)" "$MESSAGE"

# Build the request body
BODY=$(jq -n --arg message "$MESSAGE" '{message: $message}')

# Build options object if any option is provided
OPTIONS_PARTS=()
if [ -n "$MAX_TASKS" ] && [ "$MAX_TASKS" != "" ]; then
  OPTIONS_PARTS+=("maxTasks")
fi
if [ -n "$DEFAULT_PRIORITY" ] && [ "$DEFAULT_PRIORITY" != "" ]; then
  OPTIONS_PARTS+=("defaultPriority")
fi

if [ ${#OPTIONS_PARTS[@]} -gt 0 ]; then
  OPTIONS=$(jq -n '{}')
  if [ -n "$MAX_TASKS" ] && [ "$MAX_TASKS" != "" ]; then
    OPTIONS=$(printf '%s' "$OPTIONS" | jq --argjson mt "$MAX_TASKS" '. + {maxTasks: $mt}')
  fi
  if [ -n "$DEFAULT_PRIORITY" ] && [ "$DEFAULT_PRIORITY" != "" ]; then
    OPTIONS=$(printf '%s' "$OPTIONS" | jq --arg dp "$DEFAULT_PRIORITY" '. + {defaultPriority: $dp}')
  fi
  BODY=$(printf '%s' "$BODY" | jq --argjson options "$OPTIONS" '. + {options: $options}')
fi

api_call POST "/requests/plan" "$BODY"
