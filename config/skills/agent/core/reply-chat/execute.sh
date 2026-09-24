#!/bin/bash
# Send a message to the Crewly Chat UI via the backend API
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
CONVERSATION_ID=""
TEXT=""
SENDER_NAME=""
SENDER_TYPE="agent"

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --conversation|-C) CONVERSATION_ID="$2"; shift 2 ;;
    --text|-t) TEXT="$2"; shift 2 ;;
    --text-file) TEXT="$(cat "$2")"; shift 2 ;;
    --sender|-s) SENDER_NAME="$2"; shift 2 ;;
    --sender-type) SENDER_TYPE="$2"; shift 2 ;;
    --interim) INTERIM="true"; shift ;;
    --json|-j) INPUT_JSON="$2"; shift 2 ;;
    --) shift; break ;;
    *) if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift; else error_exit "Unknown argument: $1"; fi ;;
  esac
done

# Read stdin if available
if [ -z "$INPUT_JSON" ] && [ -z "$TEXT" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then INPUT_JSON="$STDIN_DATA"; else TEXT="$STDIN_DATA"; fi
fi

if [ -n "$INPUT_JSON" ]; then
  CONVERSATION_ID=${CONVERSATION_ID:-$(echo "$INPUT_JSON" | jq -r '.conversationId // empty')}
  TEXT=${TEXT:-$(echo "$INPUT_JSON" | jq -r '.content // .text // empty')}
  SENDER_NAME=${SENDER_NAME:-$(echo "$INPUT_JSON" | jq -r '.senderName // empty')}
  SENDER_TYPE=${SENDER_TYPE:-$(echo "$INPUT_JSON" | jq -r '.senderType // "agent"')}
  INTERIM=${INTERIM:-$(echo "$INPUT_JSON" | jq -r 'if .interim == true then "true" else empty end')}
fi

require_param "content" "$TEXT"
require_param "senderName" "$SENDER_NAME"

# Convert literal \n to real newlines
if [ -n "$TEXT" ]; then _NL=$'\n'; TEXT="${TEXT//\\n/$_NL}"; fi

BODY=$(jq -n \
  --arg content "$TEXT" \
  --arg senderName "$SENDER_NAME" \
  --arg senderType "$SENDER_TYPE" \
  --arg conversationId "$CONVERSATION_ID" \
  --arg interim "${INTERIM:-}" \
  '{content: $content, senderName: $senderName, senderType: $senderType} +
   (if $conversationId != "" then {conversationId: $conversationId} else {} end) +
   (if $interim == "true" then {interim: true} else {} end)')

api_call POST "/chat/agent-response" "$BODY"
