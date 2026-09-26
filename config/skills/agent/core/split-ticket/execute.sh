#!/bin/bash
# =============================================================================
# split-ticket — move an ask out of a ticket into its own ticket (#827)
#
# Backed by GET /api/tickets/:tkt (list mode) and POST /api/tickets/:id/split
# (specs/ticket-loop.md, "New asks in a thread").
#
# Usage:
#   bash execute.sh --ticket TKT-039 --list
#   bash execute.sh --ticket TKT-039 --discussion-ref <ref> [--title "…"] [--assignee <session>] [--question]
#   bash execute.sh --ticket TKT-039 --text "research X" [--title "…"] [--assignee <session>] [--question]
#   bash execute.sh '{"ticket":"TKT-039","discussionRef":"<ref>"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --ticket TKT-039 --list                       Show the ticket's follow-ups (with their refs)
  bash execute.sh --ticket TKT-039 --discussion-ref <ref>       Move that follow-up out into its own ticket
  bash execute.sh --ticket TKT-039 --text "the new ask"         Open a new ticket from text

Options:
  --ticket          TKT-039, 39 or the ticket id (required)
  --list            List the follow-ups instead of splitting
  --discussion-ref  ref of the follow-up to move out (from --list)
  --text            Text of the new ask (when not moving a follow-up)
  --title           Title for the new ticket
  --assignee        Agent session that takes it (default: the source ticket's assignee)
  --question        A pure information question: no acceptance step
  --help | -h       Show this help
EOF_USAGE
}

TICKET=""; LIST=""; DREF=""; TEXT=""; TITLE=""; ASSIGNEE=""; QUESTION="false"
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  TICKET=$(printf '%s' "$1" | jq -r '.ticket // .requestId // empty')
  DREF=$(printf '%s' "$1" | jq -r '.discussionRef // empty')
  TEXT=$(printf '%s' "$1" | jq -r '.text // empty')
  TITLE=$(printf '%s' "$1" | jq -r '.title // empty')
  ASSIGNEE=$(printf '%s' "$1" | jq -r '.assignee // empty')
  QUESTION=$(printf '%s' "$1" | jq -r 'if .question == true then "true" else "false" end')
  LIST=$(printf '%s' "$1" | jq -r 'if .list == true then "1" else empty end')
  shift || true
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket|--request-id) [ $# -ge 2 ] || error_exit "--ticket requires a value";         TICKET="$2";   shift 2 ;;
    --list)                LIST="1"; shift ;;
    --discussion-ref)      [ $# -ge 2 ] || error_exit "--discussion-ref requires a value"; DREF="$2";     shift 2 ;;
    --text)                [ $# -ge 2 ] || error_exit "--text requires a value";           TEXT="$2";     shift 2 ;;
    --title)               [ $# -ge 2 ] || error_exit "--title requires a value";          TITLE="$2";    shift 2 ;;
    --assignee)            [ $# -ge 2 ] || error_exit "--assignee requires a value";       ASSIGNEE="$2"; shift 2 ;;
    --question)            QUESTION="true"; shift ;;
    --help|-h)             print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

require_param "ticket" "$TICKET"

# List mode: the follow-ups, with the ref to pass to --discussion-ref.
if [ -n "$LIST" ]; then
  api_call GET "/tickets/${TICKET}" | jq '(.data.ticket // {}) as $t | {
    tkt: (.data.board.tkt // null),
    title: ($t.title // null),
    followUps: [($t.discussion // [])[] | {ref, at, text: (.text | .[0:200])}]
  } | . + {count: (.followUps | length)}'
  exit 0
fi

[ -n "$DREF" ] || [ -n "$TEXT" ] || error_exit "Give --discussion-ref <ref> (move a follow-up out) or --text \"…\" (see --list)"

BODY=$(jq -n --arg d "$DREF" --arg t "$TEXT" --arg title "$TITLE" --arg a "$ASSIGNEE" --argjson q "$QUESTION" \
  '{question: $q}
   + (if $d == "" then {} else {discussionRef: $d} end)
   + (if $t == "" then {} else {text: $t} end)
   + (if $title == "" then {} else {title: $title} end)
   + (if $a == "" then {} else {assignee: $a} end)')
api_call POST "/tickets/${TICKET}/split" "$BODY" | jq '{
  success,
  newTicket: (.data.ticket | if . then {id, ticketNumber, title, parentTicketId, threadRef: .origin.threadRef} else null end),
  moved: (.data.moved // false),
  error: (.error // null)
}'
