#!/bin/bash
# Eval skill shim: send-message
#
# Sends a message to a team member. Writes the message to
# .crewly/messages/ for eval verification.
#
# Usage:
#   bash skills/send-message.sh '{"to":"eval-dev-leo","message":"Please review PR #42"}'
#
# Output: JSON with messageId

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_log.sh"

INPUT="${1:-'{}'}"
log_tool_call "send-message" "$INPUT"

TO=$(echo "$INPUT" | jq -r '.to // "unknown"')
MESSAGE=$(echo "$INPUT" | jq -r '.message // ""')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MSG_ID="msg-$(date +%s)-$$"

mkdir -p .crewly/messages

cat > ".crewly/messages/${MSG_ID}.json" <<EOF
{
  "messageId": "$MSG_ID",
  "to": "$TO",
  "from": "eval-tl-sam",
  "message": $(echo "$MESSAGE" | jq -Rs .),
  "sentAt": "$TIMESTAMP"
}
EOF

echo "{\"success\":true,\"messageId\":\"$MSG_ID\",\"to\":\"$TO\"}"
