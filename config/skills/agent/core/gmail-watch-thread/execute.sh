#!/bin/bash
# =============================================================================
# gmail-watch-thread — wake on a reply in a Gmail thread (CREW-257)
#
# Backed by POST/GET/DELETE /api/google/gmail/watch(es). The watch is
# attributed to this agent via X-Agent-Session (set by api_call).
#
# Usage:
#   bash execute.sh --thread-id <id> [--account a@b.c]
#   bash execute.sh --thread-id <id> --stop
#   bash execute.sh --list
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

THREAD_ID=""; ACCOUNT=""; STOP=""; LIST=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT=$(read_json_input "$1"); shift || true
  THREAD_ID=$(printf '%s' "$INPUT" | jq -r '.threadId // empty')
  ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --thread-id) [ $# -ge 2 ] || error_exit "--thread-id requires a value"; THREAD_ID="$2"; shift 2 ;;
    --account)   [ $# -ge 2 ] || error_exit "--account requires a value";   ACCOUNT="$2";   shift 2 ;;
    --stop)      STOP=1; shift ;;
    --list)      LIST=1; shift ;;
    --help|-h)   sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"

if [ -n "$LIST" ]; then
  api_call GET "/google/gmail/watches" | jq -c '{success: (.success // false), watches: .data.watches}'
  exit 0
fi

require_param "thread id (--thread-id)" "$THREAD_ID"
if [ -n "$STOP" ]; then
  api_call DELETE "/google/gmail/watch/${THREAD_ID}" | jq -c '{success: (.success // false), removed: .data.removed}'
  exit 0
fi

BODY=$(jq -cn --arg t "$THREAD_ID" '{threadId: $t}')
RESPONSE=$(api_call POST "/google/gmail/watch" "$BODY" 2>&1) || {
  jq -n --arg r "$RESPONSE" '{success: false, reason: $r}'
  exit 1
}
printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), threadId: .data.threadId, event: .data.event}'
