#!/bin/bash
# Send a message to another company's Crewly account over a shared channel.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --list
  bash execute.sh --link <linkId> --message "text" [--reply-to <messageId>]
  echo "text" | bash execute.sh --link <linkId>
  bash execute.sh --link <linkId> --message-file /path/to/text

Answers an [EXTERNAL] message, or writes to the other company when the owner
asks. The owner approves messages on a new link and any that may be internal.
EOF_USAGE
}

LINK=""; MESSAGE=""; REPLY_TO=""; LIST=""
need_value() { [[ $# -ge 2 ]] || error_exit "Flag $1 needs a value. Use --help for usage."; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list|-l)      LIST="1"; shift ;;
    --link)         need_value "$@"; LINK="$2"; shift 2 ;;
    --message|-m)   need_value "$@"; MESSAGE="$2"; shift 2 ;;
    --message-file) need_value "$@"; MESSAGE="$(cat "$2")"; shift 2 ;;
    --reply-to)     need_value "$@"; REPLY_TO="$2"; shift 2 ;;
    --help|-h)      print_usage; exit 0 ;;
    *)              unknown_arg_exit "$1" ;;
  esac
done

if [ -n "$LIST" ]; then
  if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then echo "GET /shared-channels"; exit 0; fi
  api_call GET "/shared-channels"
  exit 0
fi

if [ -z "$MESSAGE" ] && [ ! -t 0 ]; then MESSAGE="$(cat)"; fi
require_param "link (--link)" "$LINK"
require_param "message (--message)" "$MESSAGE"
[[ "$LINK" =~ ^[A-Za-z0-9_-]+$ ]] || error_exit "Invalid link id: $LINK"

BODY=$(jq -nc --arg message "$MESSAGE" --arg replyTo "$REPLY_TO" \
  '{message: $message} + (if $replyTo != "" then {replyTo: $replyTo} else {} end)')

# Test hook: print the request instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "POST /shared-channels/$LINK/messages $BODY"
  exit 0
fi

api_call POST "/shared-channels/$LINK/messages" "$BODY"
