#!/bin/bash
# Send a message to the Crewly Chat UI via the backend API
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # Flag-based invocation
  bash execute.sh --conversation conv-abc123 --text "Hello from orchestrator"

  # Multi-line text from stdin
  cat message.txt | bash execute.sh --conversation conv-abc123

  # JSON argument (legacy)
  bash execute.sh '{"conversationId":"conv-abc123","content":"Hello"}'

Options:
  --conversation | -C   Chat conversation ID (optional — defaults to current)
  --text         | -t   Message text (optional when piping stdin)
  --text-file           Read message text from the specified file path
  --sender       | -s   Sender name (default: Orchestrator)
  --sender-type         Sender type: orchestrator, agent, system (default: orchestrator)
  --json         | -j   Raw JSON payload
  --help         | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
CONVERSATION_ID=""
TEXT=""
SENDER_NAME="Orchestrator"
SENDER_TYPE="orchestrator"

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --conversation|-C)
      CONVERSATION_ID="$2"
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
    --sender|-s)
      SENDER_NAME="$2"
      shift 2
      ;;
    --sender-type)
      SENDER_TYPE="$2"
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
  CONVERSATION_ID=${CONVERSATION_ID:-$(echo "$INPUT_JSON" | jq -r '.conversationId // empty')}
  TEXT=${TEXT:-$(echo "$INPUT_JSON" | jq -r '.content // .text // empty')}
  SENDER_NAME=${SENDER_NAME:-$(echo "$INPUT_JSON" | jq -r '.senderName // "Orchestrator"')}
  SENDER_TYPE=${SENDER_TYPE:-$(echo "$INPUT_JSON" | jq -r '.senderType // "orchestrator"')}
fi

if [ -z "$TEXT" ]; then
  error_exit "Message text is required. Pass --text, --text-file, pipe stdin, or include it in the JSON payload."
fi

# Convert literal \n sequences to real newlines
if [ -n "$TEXT" ]; then
  _NL=$'\n'
  TEXT="${TEXT//\\n/$_NL}"
fi

# Build JSON body
BODY=$(jq -n \
  --arg content "$TEXT" \
  --arg senderName "$SENDER_NAME" \
  --arg senderType "$SENDER_TYPE" \
  --arg conversationId "$CONVERSATION_ID" \
  '{content: $content, senderName: $senderName, senderType: $senderType} +
   (if $conversationId != "" then {conversationId: $conversationId} else {} end)')

api_call POST "/chat/agent-response" "$BODY"
