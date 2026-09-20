#!/bin/bash
# =============================================================================
# gmail-send — Send an email from the owner's Gmail
#
# Backed by POST /api/google/gmail/send. Refuses without --to and --subject.
# With --dry-run or CREWLY_GMAIL_SEND_DRY_RUN=1 nothing is sent and no
# request is made: the message preview is printed instead.
#
# Usage:
#   bash execute.sh --to a@b.c --subject "Hi" --text "Hello" [--cc x@y.z]
#                   [--thread-id <id>] [--in-reply-to "<msgid>"] [--dry-run]
#   bash execute.sh '{"to":"a@b.c","subject":"Hi","text":"Hello"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --to a@b.c --subject "Hi" --text "Hello" [--cc x@y.z]
                  [--thread-id <gmail thread id>] [--in-reply-to "<message-id>"] [--dry-run]
  bash execute.sh '{"to":"a@b.c","subject":"Hi","text":"Hello"}'

Options:
  --to            Recipient(s), comma-separated (required)
  --subject       Subject (required)
  --text          Plain-text body (or --text-file <path>)
  --text-file     Read the body from a file
  --cc            Cc recipient(s)
  --thread-id     Reply inside this Gmail thread
  --in-reply-to   Message-ID being answered (sets In-Reply-To / References)
  --dry-run       Preview only; nothing is sent (also: CREWLY_GMAIL_SEND_DRY_RUN=1)
  --account     Which connected Google account to act as (default: your primary)
  --help | -h     Show this help
EOF_USAGE
}

INPUT_JSON=""
TO=""; CC=""; SUBJECT=""; TEXT=""; TEXT_FILE=""; THREAD_ID=""; IN_REPLY_TO=""
DRY_RUN="${CREWLY_GMAIL_SEND_DRY_RUN:-}"

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)          [ $# -ge 2 ] || error_exit "--to requires a value";          TO="$2";          shift 2 ;;
    --cc)          [ $# -ge 2 ] || error_exit "--cc requires a value";          CC="$2";          shift 2 ;;
    --subject)     [ $# -ge 2 ] || error_exit "--subject requires a value";     SUBJECT="$2";     shift 2 ;;
    --text|--body) [ $# -ge 2 ] || error_exit "--text requires a value";        TEXT="$2";        shift 2 ;;
    --text-file)   [ $# -ge 2 ] || error_exit "--text-file requires a value";   TEXT_FILE="$2";   shift 2 ;;
    --thread-id)   [ $# -ge 2 ] || error_exit "--thread-id requires a value";   THREAD_ID="$2";   shift 2 ;;
    --in-reply-to) [ $# -ge 2 ] || error_exit "--in-reply-to requires a value"; IN_REPLY_TO="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --account)  [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h)     print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TO" ]          && TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
  [ -z "$CC" ]          && CC=$(printf '%s' "$INPUT" | jq -r '.cc // empty')
  [ -z "$SUBJECT" ]     && SUBJECT=$(printf '%s' "$INPUT" | jq -r '.subject // empty')
  [ -z "$TEXT" ]        && TEXT=$(printf '%s' "$INPUT" | jq -r '.text // .body // empty')
  [ -z "$THREAD_ID" ]   && THREAD_ID=$(printf '%s' "$INPUT" | jq -r '.threadId // empty')
  [ -z "$IN_REPLY_TO" ] && IN_REPLY_TO=$(printf '%s' "$INPUT" | jq -r '.inReplyTo // empty')
  [ -z "$DRY_RUN" ]     && DRY_RUN=$(printf '%s' "$INPUT" | jq -r 'if .dryRun == true then "1" else "" end')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"

if [ -n "$TEXT_FILE" ]; then
  [ -f "$TEXT_FILE" ] || error_exit "text file not found: $TEXT_FILE"
  TEXT=$(cat "$TEXT_FILE")
fi

require_param "to (--to)" "$TO"
require_param "subject (--subject)" "$SUBJECT"
require_param "text (--text or --text-file)" "$TEXT"

# Dry run: no request leaves this machine. Print a readable preview of the
# headers and body exactly as they will be sent.
if [ "$DRY_RUN" = "1" ]; then
  PREVIEW="To: ${TO}"
  [ -n "$CC" ] && PREVIEW="${PREVIEW}
Cc: ${CC}"
  PREVIEW="${PREVIEW}
Subject: ${SUBJECT}"
  [ -n "$IN_REPLY_TO" ] && PREVIEW="${PREVIEW}
In-Reply-To: ${IN_REPLY_TO}"
  [ -n "$THREAD_ID" ] && PREVIEW="${PREVIEW}
X-Gmail-Thread: ${THREAD_ID}"
  PREVIEW="${PREVIEW}

${TEXT}"
  jq -cn --arg p "$PREVIEW" '{success: true, dryRun: true, preview: $p}'
  exit 0
fi

BODY=$(jq -cn --arg to "$TO" --arg cc "$CC" --arg subject "$SUBJECT" --arg text "$TEXT" \
  --arg threadId "$THREAD_ID" --arg inReplyTo "$IN_REPLY_TO" \
  '{to: $to, subject: $subject, text: $text}
   + (if $cc != "" then {cc: $cc} else {} end)
   + (if $threadId != "" then {threadId: $threadId} else {} end)
   + (if $inReplyTo != "" then {inReplyTo: $inReplyTo} else {} end)')

RESPONSE=$(api_call POST "/google/gmail/send" "$BODY" 2>&1) || {
  printf '%s' "$RESPONSE" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -n --arg r "$RESPONSE" '{success: false, reason: $r}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), id: .data.id, threadId: .data.threadId}'
