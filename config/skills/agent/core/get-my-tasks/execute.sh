#!/bin/bash
# Retrieve all tasks assigned to this agent session
# Supports both CLI flags (preferred) and legacy JSON argument.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred — avoids shell escaping issues)
  bash execute.sh --session dev-1 --project /path/to/project

  # Legacy JSON argument (backward compatible)
  bash execute.sh '{"sessionName":"dev-1","projectPath":"/path"}'

Options:
  --session  | -s   Agent session name (required)
  --project  | -p   Project root path (required)
  --json     | -j   Raw JSON payload (same as legacy)
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
PROJECT_PATH=""

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
    --project|-p)
      PROJECT_PATH="$2"
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

# If nothing provided yet but stdin has data, read it as JSON
if [ -z "$INPUT_JSON" ] && [ -z "$SESSION_NAME" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON input if provided (backward compatible)
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
fi

require_param "sessionName (--session)" "$SESSION_NAME"
require_param "projectPath (--project)" "$PROJECT_PATH"

# URL-encode the session name and project path for query parameters
ENCODED_SESSION=$(printf '%s' "$SESSION_NAME" | jq -sRr @uri)
ENCODED_PROJECT=$(printf '%s' "$PROJECT_PATH" | jq -sRr @uri)

api_call GET "/task-management/tasks?sessionName=${ENCODED_SESSION}&projectPath=${ENCODED_PROJECT}"
