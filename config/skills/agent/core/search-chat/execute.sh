#!/bin/bash
# Search the chat history you can see (your DMs, the channels and rooms you are
# in, and messages that @-mention you) by keyword, channel and date range.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

QUERY=""
CHANNEL=""
FROM=""
TO=""
LIMIT=""
# Every other core skill takes one JSON argument; accept that form too:
#   execute.sh '{"query":"TKT-401","channel":"#x","from":"2026-10-01","to":"2026-10-09","limit":8}'
# Flags after it override the JSON.
INPUT_JSON=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query|-q) QUERY="${2:-}"; shift 2 ;;
    --channel|-c) CHANNEL="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    --limit|-l) LIMIT="${2:-}"; shift 2 ;;
    --full) shift ;;
    --help|-h)
      echo "Usage: bash execute.sh --query 'keywords' [--channel '#name'] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit 10]"
      echo "   or: bash execute.sh '{\"query\":\"keywords\",\"channel\":\"#name\",\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\",\"limit\":10}'"
      echo "  Searches chat messages you can see. All keywords must appear. Newest first."
      exit 0 ;;
    *) unknown_arg_exit "$1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$QUERY" ] && QUERY=$(printf '%s' "$INPUT" | jq -r '.query // .q // empty')
  [ -z "$CHANNEL" ] && CHANNEL=$(printf '%s' "$INPUT" | jq -r '.channel // empty')
  [ -z "$FROM" ] && FROM=$(printf '%s' "$INPUT" | jq -r '.from // empty')
  [ -z "$TO" ] && TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
  [ -z "$LIMIT" ] && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
fi

if [ -z "$QUERY" ]; then
  echo '{"success":false,"error":"--query is required (keywords to look for)"}' >&2
  exit 2
fi
if [ -n "$LIMIT" ] && ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo '{"success":false,"error":"--limit must be a number"}' >&2
  exit 2
fi

ENDPOINT="/chat/search?q=$(printf '%s' "$QUERY" | jq -sRr @uri)"
[ -n "$CHANNEL" ] && ENDPOINT="${ENDPOINT}&channel=$(printf '%s' "$CHANNEL" | jq -sRr @uri)"
[ -n "$FROM" ] && ENDPOINT="${ENDPOINT}&from=$(printf '%s' "$FROM" | jq -sRr @uri)"
[ -n "$TO" ] && ENDPOINT="${ENDPOINT}&to=$(printf '%s' "$TO" | jq -sRr @uri)"
[ -n "$LIMIT" ] && ENDPOINT="${ENDPOINT}&limit=${LIMIT}"

# Test hook: print the endpoint instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "GET $ENDPOINT"
  exit 0
fi

# Posts a team member makes with `reply --work-item` / `--new-thread` go straight to
# Slack and are not stored in the chat history this searches (CREW-877). Say so in
# the output: an empty or partial result is not proof that such a post failed. The
# reply itself returned the proof (slackChannelId + messageTs) to the member.
NOTE="Not searched: replies a team member posts with 'reply --work-item', '--new-thread' or '--ticket' can go straight to Slack and are then not in this history. A missing hit does not mean such a post failed; ask the member for its messageTs (the reply returns it) or read the Slack thread."
if ! RESP=$(api_call GET "$ENDPOINT"); then
  exit 1
fi
if printf '%s' "$RESP" | jq -e 'type == "object"' >/dev/null 2>&1; then
  printf '%s' "$RESP" | jq -c --arg note "$NOTE" '. + {note: $note}'
else
  printf '%s\n' "$RESP"
fi
