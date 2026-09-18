#!/bin/bash
# =============================================================================
# gmail-read — Read one message from the owner's Gmail (read-only)
#
# Backed by GET /api/google/gmail/messages/:id.
#
# Usage:
#   bash execute.sh --id 18f0a1b2c3d4e5f6
#   bash execute.sh '{"id":"18f0a1b2c3d4e5f6"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id <gmail message id>
  bash execute.sh '{"id":"<gmail message id>"}'

Options:
  --id   | -i   Gmail message id (required; from gmail-search)
  --help | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
ID=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id|-i)   [ $# -ge 2 ] || error_exit "--id requires a value"; ID="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ID" ] && ID=$(printf '%s' "$INPUT" | jq -r '.id // .messageId // empty')
fi

require_param "id (--id)" "$ID"

ID_ENC=$(jq -rn --arg v "$ID" '$v|@uri')
RESPONSE=$(api_call GET "/google/gmail/messages/${ID_ENC}" 2>&1) || {
  printf '%s' "$RESPONSE" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -n --arg r "$RESPONSE" '{success: false, reason: $r}'
  exit 1
}

# Oversized bodies are parked on disk by api_call; pass that envelope through.
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then
  printf '%s\n' "$RESPONSE"; exit 0
fi

printf '%s' "$RESPONSE" | jq -c '.data | {id, threadId, from, to, cc, subject, date, messageId, body, bodyType, attachments}'
