#!/bin/bash
# Send a message to an agent's terminal session.
# Supports: argument, stdin pipe, or @filepath for JSON input (#292, #293).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# CLI flags (--session/--to, --message, --force) are accepted too: the Gemini
# safe-call guide shows the flag form.
if [ "${1:-}" != "" ] && [ "${1#--}" != "${1}" ]; then
  FLAG_SESSION=""; FLAG_MESSAGE=""; FLAG_FORCE=""
  # A value flag at the end of the line (or followed by another flag) has no
  # value: say so instead of letting `shift 2` exit silently under set -e.
  flag_value() {
    case "${2-__missing__}" in
      __missing__|--session|--sessionName|--to|--message|--force)
        error_exit "Flag $1 needs a value, e.g. $1 <value>" ;;
    esac
  }
  while [ $# -gt 0 ]; do
    case "$1" in
      --session|--sessionName|--to) flag_value "$@"; FLAG_SESSION="$2"; shift 2 ;;
      --message) flag_value "$@"; FLAG_MESSAGE="$2"; shift 2 ;;
      --force) FLAG_FORCE="true"; shift ;;
      *) error_exit "Unknown option: $1" ;;
    esac
  done
  INPUT=$(jq -n --arg s "$FLAG_SESSION" --arg m "$FLAG_MESSAGE" --arg f "$FLAG_FORCE" \
    '{sessionName: $s, message: $m} + (if $f == "true" then {force: true} else {} end)')
else
  INPUT=$(read_json_input "${1:-}")
fi
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-session\",\"message\":\"hello\"}' or echo '{...}' | execute.sh"

# `to` is accepted as an alias for `sessionName` (older prompt examples used it).
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // .to // empty')
MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
FORCE=$(printf '%s' "$INPUT" | jq -r '.force // empty')
require_param "sessionName" "$SESSION_NAME"
require_param "message" "$MESSAGE"

# force=true: write directly to PTY without waiting for agent prompt.
# Use when the agent is busy and you need immediate delivery.
if [ "$FORCE" = "true" ]; then
  BODY=$(jq -n --arg message "$MESSAGE" '{message: $message, force: true}')
else
  # Never wait on a busy recipient: wait at most 10 s for an idle one, else
  # the backend queues the message (`queueIfBusy`) and answers at once with
  # its queue position. It is delivered when the recipient is idle.
  BODY=$(jq -n --arg message "$MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 10000, queueIfBusy: true}')
fi

RESP=$(api_call POST "/terminal/${SESSION_NAME}/deliver" "$BODY")

# A `queued` answer means the message was not typed into the recipient's
# session yet: it waits on its queue and is delivered automatically. Say so
# plainly so the caller neither waits for it nor resends it.
if printf '%s' "$RESP" | jq -e 'type == "object" and .queued == true' >/dev/null 2>&1; then
  printf '%s' "$RESP" | jq -c --arg to "$SESSION_NAME" '. + {
    delivered: false,
    note: (if .spendCapped == true
      then "Not delivered yet: \($to) has hit its daily token cap and takes no new turns. Your message is queued and is delivered automatically when the cap resets at midnight or the owner boosts it. Do not resend."
      else "Not delivered yet: \($to) is busy. Your message is queued\(if .position then " (position \(.position))" else "" end) and is delivered automatically when \($to) is idle. Do not resend and do not wait for it; carry on."
      end)
  }'
else
  printf '%s\n' "$RESP"
fi
