#!/bin/bash
# =============================================================================
# whatsapp-read — Read one WhatsApp chat, search messages, or list chats
#
# Backed by:
#   GET /api/whatsapp/chats/<chatId>/messages?limit=&before=   (--chat)
#   GET /api/whatsapp/search?q=&limit=                         (--q)
#   GET /api/whatsapp/chats?q=&limit=                          (--chats)
# Read-only.
#
# Usage:
#   bash execute.sh --chat <jid> [--limit 50] [--before <epoch ms>]
#   bash execute.sh --q "dinner" [--limit 20]
#   bash execute.sh --chats [--q "ann"] [--limit 50]
#   bash execute.sh '{"chatId":"…","limit":50}' | '{"q":"dinner"}' | '{"chats":true}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --chat <jid> [--limit 50] [--before <epoch ms>]
  bash execute.sh --q "text" [--limit 20]
  bash execute.sh --chats [--q "name"] [--limit 50]

Options:
  --chat       Chat JID to read (from whatsapp-inbox / --chats)
  --before     Page back: only messages older than this epoch-ms (use nextBefore)
  --q          Search text (with --chats: filter chat names)
  --chats      List recent chats instead of messages
  --limit      Row cap
  --help | -h  Show this help
EOF_USAGE
}

INPUT_JSON=""
CHAT=""; Q=""; LIMIT=""; BEFORE=""; LIST_CHATS=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat|-c)   [ $# -ge 2 ] || error_exit "--chat requires a value";   CHAT="$2";   shift 2 ;;
    --q|--query) [ $# -ge 2 ] || error_exit "--q requires a value";      Q="$2";      shift 2 ;;
    --limit|-n)  [ $# -ge 2 ] || error_exit "--limit requires a value";  LIMIT="$2";  shift 2 ;;
    --before)    [ $# -ge 2 ] || error_exit "--before requires a value"; BEFORE="$2"; shift 2 ;;
    --chats)     LIST_CHATS=1; shift ;;
    --help|-h)   print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$CHAT" ]       && CHAT=$(printf '%s' "$INPUT" | jq -r '.chatId // .chat // empty')
  [ -z "$Q" ]          && Q=$(printf '%s' "$INPUT" | jq -r '.q // .query // empty')
  [ -z "$LIMIT" ]      && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
  [ -z "$BEFORE" ]     && BEFORE=$(printf '%s' "$INPUT" | jq -r '.before // empty')
  [ -z "$LIST_CHATS" ] && LIST_CHATS=$(printf '%s' "$INPUT" | jq -r 'if .chats == true then "1" else "" end')
fi

uri() { jq -rn --arg v "$1" '$v|@uri'; }

if [ -n "$LIST_CHATS" ]; then
  MODE=chats
  QS=""
  [ -n "$Q" ] && QS="q=$(uri "$Q")"
  [ -n "$LIMIT" ] && QS="${QS:+${QS}&}limit=$(uri "$LIMIT")"
  ENDPOINT="/whatsapp/chats${QS:+?${QS}}"
elif [ -n "$CHAT" ]; then
  MODE=chat
  QS=""
  [ -n "$LIMIT" ] && QS="limit=$(uri "$LIMIT")"
  [ -n "$BEFORE" ] && QS="${QS:+${QS}&}before=$(uri "$BEFORE")"
  ENDPOINT="/whatsapp/chats/$(uri "$CHAT")/messages${QS:+?${QS}}"
elif [ -n "$Q" ]; then
  MODE=search
  QS="q=$(uri "$Q")"
  [ -n "$LIMIT" ] && QS="${QS}&limit=$(uri "$LIMIT")"
  ENDPOINT="/whatsapp/search?${QS}"
else
  error_exit "Pass --chat <jid>, --q <text>, or --chats"
fi

# stderr is kept apart so lib.sh's session warning cannot pollute a good response.
ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call GET "$ENDPOINT" 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{success: false, reason: (.details.code // .details.error // .details // .error // "unknown"), message: (.details.error // "")}' 2>/dev/null \
    || jq -n --arg r "$ERR" '{success: false, reason: $r}'
  exit 1
}

if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then
  printf '%s\n' "$RESPONSE"; exit 0
fi

# One compact line per message: who, when, what.
MSG_SHAPE='{at: ((.ts / 1000) | floor | todate), fromMe: .fromMe, sender: (if .fromMe then "me" else (.senderName // .senderJid) end), kind: .kind, text: .text}'

case "$MODE" in
  chats)
    printf '%s' "$RESPONSE" | jq -c '{count: (.data | length), chats: [.data[] | {chatId: .id, name: (.name // .id), isGroup: .isGroup, lastAt: (if .lastMessageAt then ((.lastMessageAt / 1000) | floor | todate) else null end)}]}'
    ;;
  chat)
    printf '%s' "$RESPONSE" | jq -c "{chat: {chatId: .data.chat.id, name: (.data.chat.name // .data.chat.id), isGroup: .data.chat.isGroup}, messages: [.data.messages[] | ${MSG_SHAPE}], nextBefore: .data.nextBefore}"
    ;;
  search)
    printf '%s' "$RESPONSE" | jq -c "{count: (.data | length), hits: [.data[] | ({chatId: .chatId, chatName: (.chatName // .chatId)} + ${MSG_SHAPE})]}"
    ;;
esac
