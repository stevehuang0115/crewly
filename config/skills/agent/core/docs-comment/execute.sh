#!/bin/bash
# =============================================================================
# docs-comment — List, reply to, resolve or add comments in a Google Doc
#
# Backed by:
#   GET  /api/google/docs/:id/comments[?includeResolved=1]
#   POST /api/google/docs/:id/comments                     { text, quote? }
#   POST /api/google/docs/:id/comments/:commentId/replies  { text }
#   POST /api/google/docs/:id/comments/:commentId/resolve  { text? }
#
# Usage:
#   bash execute.sh list    --doc <id|url> [--include-resolved]
#   bash execute.sh reply   --doc <id|url> --comment <id> --text "…"
#   bash execute.sh resolve --doc <id|url> --comment <id> [--text "…"]
#   bash execute.sh add     --doc <id|url> --text "…" [--quote "exact text"]
#   bash execute.sh '{"command":"list","doc":"<id>"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh list    --doc <id|url> [--include-resolved]
  bash execute.sh reply   --doc <id|url> --comment <id> --text "…"
  bash execute.sh resolve --doc <id|url> --comment <id> [--text "…"]
  bash execute.sh add     --doc <id|url> --text "…" [--quote "exact text in the doc"]
  bash execute.sh '{"command":"reply","doc":"<id>","comment":"<id>","text":"…"}'

Options:
  --doc               Document id or docs.google.com URL
  --comment           Comment id (from list)
  --text              Reply / comment text (optional for resolve)
  --quote             Exact document text the new comment is about (add only;
                      Google Docs may still show it as an unanchored comment)
  --include-resolved  list: include resolved comments too
  --account           Which connected Google account to act as (default: your primary)
  --help | -h         Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")} + (if .details.reconnectLinkSent == true then {reconnectLinkSent: true} else {} end)' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# api_call may print a one-line warning to stderr (no CREWLY_SESSION_NAME);
# the backend answer is always the last line. On failure print the mapped
# failure JSON (fail_from) and return 1.
call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s\n' "$out" | tail -n 1)"; }
  printf '%s\n' "$out" | tail -n 1
}

INPUT_JSON=""
COMMAND=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
elif [[ $# -gt 0 && ${1:0:1} != '-' ]]; then
  COMMAND="$1"
  shift
fi
DOC=""; COMMENT=""; TEXT=""; TEXT_SET=0; QUOTE=""; INCLUDE_RESOLVED=0; ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --doc|--id)         [ $# -ge 2 ] || error_exit "$1 requires a value";        DOC="$2";     shift 2 ;;
    --comment)          [ $# -ge 2 ] || error_exit "--comment requires a value"; COMMENT="$2"; shift 2 ;;
    --text)             [ $# -ge 2 ] || error_exit "--text requires a value";    TEXT="$2"; TEXT_SET=1; shift 2 ;;
    --quote)            [ $# -ge 2 ] || error_exit "--quote requires a value";   QUOTE="$2";   shift 2 ;;
    --include-resolved) INCLUDE_RESOLVED=1; shift ;;
    --account)          [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h)          print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$COMMAND" ] && COMMAND=$(printf '%s' "$INPUT" | jq -r '.command // .action // empty')
  [ -z "$DOC" ]     && DOC=$(printf '%s' "$INPUT" | jq -r '.doc // .id // .documentId // empty')
  [ -z "$COMMENT" ] && COMMENT=$(printf '%s' "$INPUT" | jq -r '.comment // .commentId // empty')
  [ "$TEXT_SET" -eq 0 ] && TEXT=$(printf '%s' "$INPUT" | jq -r '.text // empty')
  [ -z "$QUOTE" ]   && QUOTE=$(printf '%s' "$INPUT" | jq -r '.quote // empty')
  [ "$INCLUDE_RESOLVED" -eq 0 ] && [ "$(printf '%s' "$INPUT" | jq -r '.includeResolved // false')" = "true" ] && INCLUDE_RESOLVED=1
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"
# Accept a full docs.google.com URL too.
DOC=$(printf '%s' "$DOC" | sed -E 's#.*/document/d/([^/?]+).*#\1#')

[ -n "$COMMAND" ] || error_exit "a command is required: list, reply, resolve or add (see --help)"
require_param "doc (--doc)" "$DOC"
BASE="/google/docs/$(uri "$DOC")/comments"

case "$COMMAND" in
  list)
    QS=""; [ "$INCLUDE_RESOLVED" -eq 1 ] && QS="?includeResolved=1"
    RESPONSE=$(call GET "${BASE}${QS}") || { printf '%s\n' "$RESPONSE"; exit 1; }
    # Oversized answers come back as the output-cap envelope; pass it through.
    if printf '%s' "$RESPONSE" | jq -e '.truncated == true and has("file")' >/dev/null 2>&1; then printf '%s\n' "$RESPONSE"; exit 0; fi
    printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), docId: .data.docId, count: (.data.comments | length), truncated: (.data.truncated // false), comments: .data.comments}'
    ;;
  reply)
    require_param "comment (--comment)" "$COMMENT"
    require_param "text (--text)" "$TEXT"
    BODY=$(jq -cn --arg text "$TEXT" '{text: $text}')
    RESPONSE=$(call POST "${BASE}/$(uri "$COMMENT")/replies" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), action: "reply", docId: .data.docId, commentId: .data.commentId, replyId: .data.id, content: .data.content}'
    ;;
  resolve)
    require_param "comment (--comment)" "$COMMENT"
    BODY=$(jq -cn --arg text "$TEXT" 'if $text != "" then {text: $text} else {} end')
    RESPONSE=$(call POST "${BASE}/$(uri "$COMMENT")/resolve" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), action: "resolve", docId: .data.docId, commentId: .data.commentId, replyId: .data.id, content: (.data.content // ""), resolved: true}'
    ;;
  add)
    require_param "text (--text)" "$TEXT"
    BODY=$(jq -cn --arg text "$TEXT" --arg quote "$QUOTE" '{text: $text} + (if $quote != "" then {quote: $quote} else {} end)')
    RESPONSE=$(call POST "${BASE}" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), action: "add", docId: .data.docId, commentId: .data.id, content: .data.content} + (if .data.quote then {quote: .data.quote} else {} end)'
    ;;
  *)
    error_exit "Unknown command: $COMMAND (expected list, reply, resolve or add)"
    ;;
esac
