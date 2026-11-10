#!/bin/bash
# Send a private message to a colleague agent (any machine of this account).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --to <name|agentSession> --message "text" [--reply-to <id>] [--team <team>]
  echo "text" | bash execute.sh --to <name>
  bash execute.sh --to <name> --message-file /path/to/text

Use when the owner (or your lead, for the owner) asks you to reach someone
outside your Slack channel, or to answer a colleague who wrote to you.
EOF_USAGE
}

TO=""; MESSAGE=""; REPLY_TO=""; TEAM=""
need_value() { [[ $# -ge 2 ]] || error_exit "Flag $1 needs a value. Use --help for usage."; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to|-t)        need_value "$@"; TO="$2"; shift 2 ;;
    --message|-m)   need_value "$@"; MESSAGE="$2"; shift 2 ;;
    --message-file) need_value "$@"; MESSAGE="$(cat "$2")"; shift 2 ;;
    --reply-to)     need_value "$@"; REPLY_TO="$2"; shift 2 ;;
    --team)         need_value "$@"; TEAM="$2"; shift 2 ;;
    --help|-h)      print_usage; exit 0 ;;
    *)              unknown_arg_exit "$1" ;;
  esac
done

if [ -z "$MESSAGE" ] && [ ! -t 0 ]; then MESSAGE="$(cat)"; fi
require_param "to (--to)" "$TO"
require_param "message (--message)" "$MESSAGE"

BODY=$(jq -nc --arg to "$TO" --arg message "$MESSAGE" --arg replyTo "$REPLY_TO" --arg team "$TEAM" \
  '{to: $to, message: $message}
   + (if $replyTo != "" then {replyTo: $replyTo} else {} end)
   + (if $team != "" then {team: $team} else {} end)')

# Test hook: print the request instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "POST /colleagues/message $BODY"
  exit 0
fi

api_call POST "/colleagues/message" "$BODY"
