#!/bin/bash
# =============================================================================
# gmail-search — Search the owner's Gmail (read-only)
#
# Backed by GET /api/google/gmail/search?q=&max= (Cloud holds the Google
# grant; this instance talks to Gmail directly).
#
# Usage:
#   bash execute.sh --query "is:unread from:ann" [--max 10]
#   bash execute.sh '{"query":"is:unread","max":10}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --query "is:unread from:ann" [--max 10]
  bash execute.sh '{"query":"is:unread","max":10}'

Options:
  --query | -q   Gmail search query (required)
  --max   | -n   Result cap (default 20, max 100)
  --help  | -h   Show this help
  --account     Which connected Google account to act as (default: your primary)
EOF_USAGE
}

INPUT_JSON=""
QUERY=""
MAX=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query|-q) [ $# -ge 2 ] || error_exit "--query requires a value"; QUERY="$2"; shift 2 ;;
    --max|-n)   [ $# -ge 2 ] || error_exit "--max requires a value";   MAX="$2";   shift 2 ;;
    --account)  [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$QUERY" ] && QUERY=$(printf '%s' "$INPUT" | jq -r '.query // .q // empty')
  [ -z "$MAX" ] && MAX=$(printf '%s' "$INPUT" | jq -r '.max // empty')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"

require_param "query (--query)" "$QUERY"

Q_ENC=$(jq -rn --arg v "$QUERY" '$v|@uri')
ENDPOINT="/google/gmail/search?q=${Q_ENC}"
[ -n "$MAX" ] && ENDPOINT="${ENDPOINT}&max=$(jq -rn --arg v "$MAX" '$v|@uri')"

RESPONSE=$(api_call GET "$ENDPOINT" 2>&1) || {
  printf '%s' "$RESPONSE" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -n --arg r "$RESPONSE" '{success: false, reason: $r}'
  exit 1
}

# Oversized bodies are parked on disk by api_call; pass that envelope through.
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then
  printf '%s\n' "$RESPONSE"; exit 0
fi

printf '%s' "$RESPONSE" | jq -c '{query: .data.query, count: .data.count, messages: [.data.messages[] | {id, threadId, from, to, subject, date, snippet}]}'
