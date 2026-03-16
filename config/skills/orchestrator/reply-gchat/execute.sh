#!/bin/bash
# Send a message to a Google Chat space or thread via the backend API
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # Flag-based invocation
  bash execute.sh --space "spaces/AAAA" --text "Hello" --thread "spaces/AAAA/threads/BBB"

  # Multi-line text from stdin
  cat message.txt | bash execute.sh --space "spaces/AAAA" --thread "spaces/AAAA/threads/BBB"

  # JSON argument (legacy)
  bash execute.sh '{"space":"spaces/AAAA","text":"Hello","threadName":"spaces/AAAA/threads/BBB"}'

Options:
  --space    | -s   Google Chat space name (required)
  --text     | -t   Message text (optional when piping stdin)
  --text-file       Read message text from the specified file path
  --thread   | -r   Thread name for threaded replies
  --conversation | -C  Conversation ID from [GCHAT:...] prefix
  --json     | -j   Raw JSON payload
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SPACE=""
TEXT=""
THREAD_NAME=""
CONVERSATION_ID=""

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --space|-s)
      SPACE="$2"
      shift 2
      ;;
    --text|-t)
      TEXT="$2"
      shift 2
      ;;
    --text-file)
      TEXT="$(cat "$2")"
      shift 2
      ;;
    --thread|-r)
      THREAD_NAME="$2"
      shift 2
      ;;
    --conversation|-C)
      CONVERSATION_ID="$2"
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
        error_exit "Unknown argument: $1"
      fi
      ;;
  esac
done

# If nothing provided yet, but stdin has data, read it
if [ -z "$INPUT_JSON" ] && [ -z "$TEXT" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    TEXT="$STDIN_DATA"
  fi
fi

if [ -n "$INPUT_JSON" ]; then
  SPACE=${SPACE:-$(echo "$INPUT_JSON" | jq -r '.space // empty')}
  TEXT=${TEXT:-$(echo "$INPUT_JSON" | jq -r '.text // empty')}
  THREAD_NAME=${THREAD_NAME:-$(echo "$INPUT_JSON" | jq -r '.threadName // empty')}
  CONVERSATION_ID=${CONVERSATION_ID:-$(echo "$INPUT_JSON" | jq -r '.conversationId // empty')}
fi

require_param "space" "$SPACE"

if [ -z "$TEXT" ]; then
  error_exit "Message text is required. Pass --text, --text-file, pipe stdin, or include it in the JSON payload."
fi

# Convert literal \n sequences to real newlines
if [ -n "$TEXT" ]; then
  _NL=$'\n'
  TEXT="${TEXT//\\n/$_NL}"
fi

# Build JSON body
if [ -n "$THREAD_NAME" ]; then
  BODY=$(jq -n --arg space "$SPACE" --arg text "$TEXT" --arg threadName "$THREAD_NAME" \
    '{space: $space, text: $text, threadName: $threadName}')
else
  BODY=$(jq -n --arg space "$SPACE" --arg text "$TEXT" \
    '{space: $space, text: $text}')
fi

api_call POST "/messengers/google-chat/send" "$BODY"
