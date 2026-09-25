#!/bin/bash
# =============================================================================
# whatsapp-inbox — Which WhatsApp chats need a reply (read-only)
#
# Backed by GET /api/whatsapp/inbox?limit=&includeGroups=.
# A chat "needs a reply" when its newest message is not the owner's.
# Groups are excluded unless --include-groups is given (they are noisy).
#
# Usage:
#   bash execute.sh [--limit 20] [--include-groups]
#   bash execute.sh '{"limit":20,"includeGroups":true}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

# Characters of each chat's last message shown (keeps the output small).
PREVIEW_CHARS="${CREWLY_WHATSAPP_PREVIEW_CHARS:-200}"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh [--limit 20] [--include-groups]
  bash execute.sh '{"limit":20,"includeGroups":true}'

Options:
  --limit            Max chats (default 20, max 200)
  --include-groups   Also list group chats (default: 1:1 chats only)
  --help | -h        Show this help
EOF_USAGE
}

INPUT_JSON=""
LIMIT=""; INCLUDE_GROUPS=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit|-n)       [ $# -ge 2 ] || error_exit "--limit requires a value"; LIMIT="$2"; shift 2 ;;
    --include-groups) INCLUDE_GROUPS=1; shift ;;
    --help|-h)        print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$LIMIT" ] && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
  [ -z "$INCLUDE_GROUPS" ] && INCLUDE_GROUPS=$(printf '%s' "$INPUT" | jq -r 'if .includeGroups == true then "1" else "" end')
fi

QS=""
[ -n "$LIMIT" ] && QS="limit=$(jq -rn --arg v "$LIMIT" '$v|@uri')"
if [ -n "$INCLUDE_GROUPS" ]; then
  QS="${QS:+${QS}&}includeGroups=true"
fi

# stderr is kept apart so lib.sh's session warning cannot pollute a good response.
ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call GET "/whatsapp/inbox${QS:+?${QS}}" 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{success: false, reason: (.details.code // .details.error // .details // .error // "unknown"), message: (.details.error // "")}' 2>/dev/null \
    || jq -n --arg r "$ERR" '{success: false, reason: $r}'
  exit 1
}

if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then
  printf '%s\n' "$RESPONSE"; exit 0
fi

printf '%s' "$RESPONSE" | jq -c --argjson n "$PREVIEW_CHARS" '{
  count: (.data | length),
  chats: [.data[] | {
    chatId: .chat.id,
    name: (.chat.name // .chat.id),
    isGroup: .chat.isGroup,
    unanswered: .unansweredCount,
    lastKind: .lastKind,
    lastFrom: .lastSenderName,
    lastText: (.lastText | .[0:$n]),
    lastAt: ((.lastMessageAt / 1000) | floor | todate)
  }]
}'
