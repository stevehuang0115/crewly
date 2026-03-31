#!/bin/bash
# Send a direct message to another agent's terminal session.
# Supports CLI flags (preferred), legacy JSON, stdin pipe, or @filepath.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --to agent-session --message "Please implement feature X"

  # Message from stdin (for multi-line or special characters)
  echo "Implement feature X — it's urgent" | bash execute.sh --to agent-session

  # Message from file
  bash execute.sh --to agent-session --message-file /tmp/task.txt

  # Legacy JSON (backward compatible)
  bash execute.sh '{"to":"agent-session","message":"..."}'

Options:
  --to       | -t   Target agent session name (required)
  --message  | -m   Message text (required unless piped via stdin)
  --message-file    Read message from file path
  --json     | -j   Raw JSON payload (same as legacy)
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
TO=""
MESSAGE=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to|-t)
      TO="$2"
      shift 2
      ;;
    --message|-m)
      MESSAGE="$2"
      shift 2
      ;;
    --message-file)
      MESSAGE="$(cat "$2")"
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

# Read from stdin if no message yet
if [ -z "$INPUT_JSON" ] && [ -z "$MESSAGE" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    MESSAGE="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TO" ] && TO=$(printf '%s' "$INPUT" | jq -r '.to // .sessionName // empty')
  [ -z "$MESSAGE" ] && MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
fi

require_param "to (--to)" "$TO"
require_param "message (--message)" "$MESSAGE"

BODY=$(jq -n --arg data "$MESSAGE" --arg mode "message" '{data: $data, mode: $mode}')

api_call POST "/terminal/${TO}/write" "$BODY"
