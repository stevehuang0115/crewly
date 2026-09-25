#!/bin/bash
# =============================================================================
# whatsapp-draft — Propose a reply to a WhatsApp chat. NEVER sends.
#
# Backed by POST /api/whatsapp/drafts {chatId, text}. The draft gets a short
# code (W12). Only the owner releases it: by replying 「发 W12」 in chat (then
# whatsapp-send), or by pressing 发送 in the dashboard.
#
# Usage:
#   bash execute.sh --chat <jid> --text "reply text"
#   bash execute.sh --chat <jid> --text-file /path/to/reply.txt
#   bash execute.sh '{"chatId":"…","text":"…"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --chat <jid> --text "reply text"
  bash execute.sh --chat <jid> --text-file /path/to/reply.txt
  bash execute.sh '{"chatId":"…","text":"…"}'

Options:
  --chat        Recipient chat JID (must already be in the inbox)
  --text        Reply text
  --text-file   Read the reply text from a file
  --help | -h   Show this help

This only saves a draft. It never sends.
EOF_USAGE
}

INPUT_JSON=""
CHAT=""; TEXT=""; TEXT_FILE=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat|-c)   [ $# -ge 2 ] || error_exit "--chat requires a value";      CHAT="$2";      shift 2 ;;
    --text)      [ $# -ge 2 ] || error_exit "--text requires a value";      TEXT="$2";      shift 2 ;;
    --text-file) [ $# -ge 2 ] || error_exit "--text-file requires a value"; TEXT_FILE="$2"; shift 2 ;;
    --help|-h)   print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$CHAT" ] && CHAT=$(printf '%s' "$INPUT" | jq -r '.chatId // .chat // empty')
  [ -z "$TEXT" ] && TEXT=$(printf '%s' "$INPUT" | jq -r '.text // empty')
fi

if [ -n "$TEXT_FILE" ]; then
  [ -f "$TEXT_FILE" ] || error_exit "text file not found: $TEXT_FILE"
  TEXT=$(cat "$TEXT_FILE")
fi

require_param "chat (--chat)" "$CHAT"
require_param "text (--text or --text-file)" "$TEXT"

BODY=$(jq -cn --arg chatId "$CHAT" --arg text "$TEXT" '{chatId: $chatId, text: $text}')

# stderr is kept apart so lib.sh's session warning cannot pollute a good response.
ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call POST "/whatsapp/drafts" "$BODY" 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{success: false, reason: (.details.code // .details.error // .details // .error // "unknown"), message: (.details.error // "")}' 2>/dev/null \
    || jq -n --arg r "$ERR" '{success: false, reason: $r}'
  exit 1
}

# The next step is the owner's, not ours: say so in the output itself.
printf '%s' "$RESPONSE" | jq -c '.data as $d | {
  success: true,
  sent: false,
  draft: {id: $d.id, code: $d.code, recipient: $d.recipient, chatId: $d.chatId, text: $d.text},
  nextStep: ("NOT SENT. Show the owner: recipient \($d.recipient), the exact text above, and code \($d.code). Ask them to reply 「发 \($d.code)」 to send it (or use 发送/丢弃 in the dashboard). Do not call whatsapp-send until they have replied 「发 \($d.code)」.")
}'
