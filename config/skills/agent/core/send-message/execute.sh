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

# A value flag at the end of the line (or followed by another of this skill's
# flags) has no value: say so instead of failing on an unset "$2". Any other
# value is kept, so a message may still start with "-".
flag_value() {
  if [[ $# -lt 2 ]]; then
    error_exit "Flag $1 needs a value, e.g. $1 <value>. Use --help for usage."
  fi
  case "$2" in
    --to|-t|--message|-m|--message-file|--json|-j|--help|-h)
      error_exit "Flag $1 needs a value, e.g. $1 <value>. Use --help for usage." ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to|-t|--message|-m|--message-file|--json|-j) flag_value "$@" ;;
  esac
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

RESP=$(api_call POST "/terminal/${TO}/write" "$BODY")

# A 202 `queued` answer means the message was NOT typed into the recipient's
# session yet: it is held on its queue (daily token cap `spendCapped`, agent
# still starting, session down, …) and delivered automatically later (#937).
# Say so plainly so the sender neither treats it as read nor resends it.
if printf '%s' "$RESP" | jq -e 'type == "object" and .queued == true' >/dev/null 2>&1; then
  printf '%s' "$RESP" | jq -c --arg to "$TO" '. + {
    delivered: false,
    note: (if .spendCapped == true
      then "Not delivered yet: \($to) has hit its daily token cap and takes no new turns. Your message is queued and is delivered automatically when the cap resets at midnight or the owner boosts it. Do not resend; do not wait on a reply today."
      else "Not delivered yet: your message to \($to) is queued and is delivered automatically. Do not resend."
      end)
  }'
else
  printf '%s\n' "$RESP"
fi
