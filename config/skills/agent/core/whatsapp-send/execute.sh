#!/bin/bash
# =============================================================================
# whatsapp-send — Send ONE WhatsApp draft the owner has confirmed
#
# Backed by POST /api/whatsapp/drafts/<id|code>/send. The backend refuses
# (403 needs_owner_confirmation) unless the owner replied 「发 <code>」 in chat
# after the draft was written, within 30 minutes. This skill cannot get
# around that, and must not try.
#
# Usage:
#   bash execute.sh --draft W12
#   bash execute.sh '{"draft":"W12"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --draft <id|code>
  bash execute.sh '{"draft":"W12"}'

Options:
  --draft      Draft id or code (W12) the owner confirmed with 「发 W12」
  --help | -h  Show this help

Fails unless the owner has replied 「发 <code>」 for this draft.
EOF_USAGE
}

INPUT_JSON=""
DRAFT=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft|-d) [ $# -ge 2 ] || error_exit "--draft requires a value"; DRAFT="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$DRAFT" ] && DRAFT=$(printf '%s' "$INPUT" | jq -r '.draft // .draftId // .code // .id // empty')
fi

require_param "draft (--draft)" "$DRAFT"

# Without X-Agent-Session the backend treats a call as the owner's own click.
# An agent must never be mistaken for the owner, so refuse to run anonymously.
if [ -z "${CREWLY_SESSION_NAME:-}" ]; then
  error_exit "CREWLY_SESSION_NAME is not set. whatsapp-send only runs as an identified agent; ask the owner to send it themselves or restart the agent."
fi

REF=$(jq -rn --arg v "$DRAFT" '$v|@uri')

# stderr is kept apart so lib.sh's session warning cannot pollute a good response.
ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call POST "/whatsapp/drafts/${REF}/send" '{}' 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{
    success: false,
    sent: false,
    reason: (.details.code // .details.error // .details // .error // "unknown"),
    message: (if .details.code == "needs_owner_confirmation"
              then "NOT SENT: the owner has not confirmed. " + (.details.error // "")
              else (.details.error // "") end)
  }' 2>/dev/null || jq -n --arg r "$ERR" '{success: false, sent: false, reason: $r}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '.data as $d | {
  success: true,
  sent: true,
  code: $d.code,
  recipient: $d.recipient,
  sentAt: (if $d.sentAt then (($d.sentAt / 1000) | floor | todate) else null end)
}'
