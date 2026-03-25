#!/bin/bash
# Send a chat response visible in the Crewly chat UI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"content\":\"Task completed successfully\",\"senderName\":\"dev-1\"}'"

CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
SENDER_NAME=$(printf '%s' "$INPUT" | jq -r '.senderName // empty')
SENDER_TYPE=$(printf '%s' "$INPUT" | jq -r '.senderType // empty')
CONVERSATION_ID=$(printf '%s' "$INPUT" | jq -r '.conversationId // empty')
require_param "content" "$CONTENT"
require_param "senderName" "$SENDER_NAME"

BODY=$(jq -n \
  --arg content "$CONTENT" \
  --arg senderName "$SENDER_NAME" \
  --arg senderType "$SENDER_TYPE" \
  --arg conversationId "$CONVERSATION_ID" \
  '{content: $content, senderName: $senderName} +
   (if $senderType != "" then {senderType: $senderType} else {} end) +
   (if $conversationId != "" then {conversationId: $conversationId} else {} end)')

api_call POST "/chat/agent-response" "$BODY"
