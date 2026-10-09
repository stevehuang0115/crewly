#!/bin/bash
# reply — answer the work you are doing. The harness sends it back where
# that work came from (the owner's Slack DM / room thread / portal chat, the
# ticket's thread, or a new top-level post for scheduled work) — no channel
# ids, no choosing between reply-channel / reply-chat / reply-slack.
# `--new-thread "<title>"` starts a new topic in your team channel. Status lines ([DONE], [BLOCKED], …) still go to the
# orchestrator. See specs/2026-09-30-owner-message-guarantee.md §B.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh "your reply"                 # goes back where the message came from
  echo "multi-line reply" | bash execute.sh
  bash execute.sh --text-file /path/reply.md
  bash execute.sh --interim "Got it — comparing the three quotes (~10 min)."
  bash execute.sh --none                       # no answer needed for this message
  bash execute.sh --new-thread "Wiki link audit" "Found 3 broken links: …"   # a new topic
  bash execute.sh --ticket TKT-187 "Here is the preview: https://…"   # answer about a ticket
  bash execute.sh --to <messageId> "Yes — done."                     # answer a specific message
  bash execute.sh --drive <session> "好的，下午三点前发你。"           # the owner is in Drive mode (voice)
  bash execute.sh --drive <session> --recap "Drive mode recap — …"   # after the Drive mode session ended

Options:
  --text | -t        Reply text (or the first positional argument, or stdin)
  --text-file        Read the reply from a file
  --interim          A short note before the real answer; "working on it" stays up
  --none             Nothing to answer (already answered elsewhere / not for you)
  --adds-new         Post even though the agent chosen to answer the owner here
                     already replied (when you have something new, or were asked)
  --new-thread       Start a new thread in your team channel with this title (a new topic)
  --ticket           The ticket you are answering about (TKT-187, or a project ticket like CE-7)
  --to               The message id you are answering (from your prompt)
  --work-item        The work item you are answering about
  --decision         The owner decision you are following up (D-12)
  --drive <session>  The owner is in Drive mode (listening on the phone): your answer
                     goes to their phone, not Slack. Short, spoken, no URLs/tables.
  --recap            With --drive, after the session ended: your one recap, posted
                     in your DM with the owner (or the channel); closes the conversation
  --conversation|-C  Only if your prompt tells you to answer somewhere specific
  --thread | -T      Only if your prompt tells you to answer in a specific thread
  --help | -h        Show this help
EOF_USAGE
}

TEXT=""
INTERIM=""
NONE=""
ADDS_NEW=""
CONVERSATION_ID=""
THREAD=""
NEW_THREAD=""
TICKET=""
TO=""
WORK_ITEM=""
DECISION=""
DRIVE=""
RECAP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --text|-t) TEXT="$2"; shift 2 ;;
    --text-file) TEXT="$(cat "$2")"; shift 2 ;;
    --content|-m) TEXT="$2"; shift 2 ;;
    --interim) INTERIM="1"; shift ;;
    --none) NONE="1"; shift ;;
    --adds-new) ADDS_NEW="1"; shift ;;
    --conversation|-C|--channel|-c) CONVERSATION_ID="$2"; shift 2 ;;
    --thread|-T) THREAD="$2"; shift 2 ;;
    --new-thread) NEW_THREAD="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    --to|--message) TO="$2"; shift 2 ;;
    --work-item) WORK_ITEM="$2"; shift 2 ;;
    --decision) DECISION="$2"; shift 2 ;;
    --drive) DRIVE="$2"; shift 2 ;;
    --recap) RECAP="1"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    --) shift; if [[ $# -gt 0 && -z "$TEXT" ]]; then TEXT="$*"; fi; break ;;
    -*) echo "{\"success\":false,\"error\":\"Unknown option: $1\"}" >&2; print_usage >&2; exit 2 ;;
    *) if [ -z "$TEXT" ]; then TEXT="$1"; else TEXT="$TEXT $1"; fi; shift ;;
  esac
done

if [ -z "$TEXT" ] && [ -z "$NONE" ] && [ ! -t 0 ]; then
  TEXT="$(cat)"
fi

if [ -z "$TEXT" ] && [ -z "$NONE" ]; then
  echo '{"success":false,"error":"Reply text is required: reply \"<text>\" (or --none when no answer is needed)"}' >&2
  exit 2
fi

# Literal \n (from JSON-escaped text) → real newlines
if [ -n "$TEXT" ]; then _NL=$'\n'; TEXT="${TEXT//\\n/$_NL}"; fi

BODY=$(TEXT="$TEXT" INTERIM="$INTERIM" NONE="$NONE" ADDS_NEW="$ADDS_NEW" CONVERSATION_ID="$CONVERSATION_ID" THREAD="$THREAD" NEW_THREAD="$NEW_THREAD" TICKET="$TICKET" TO="$TO" WORK_ITEM="$WORK_ITEM" DECISION="$DECISION" DRIVE="$DRIVE" RECAP="$RECAP" python3 -c '
import os, json
p = {}
if os.environ.get("NONE"):
    p["none"] = True
else:
    p["content"] = os.environ["TEXT"]
if os.environ.get("INTERIM"):
    p["interim"] = True
if os.environ.get("ADDS_NEW"):
    p["addsNew"] = True
if os.environ.get("CONVERSATION_ID"):
    p["conversationId"] = os.environ["CONVERSATION_ID"]
if os.environ.get("THREAD"):
    p["thread"] = os.environ["THREAD"]
if os.environ.get("NEW_THREAD"):
    p["newThread"] = os.environ["NEW_THREAD"]
if os.environ.get("TICKET"):
    p["ticket"] = os.environ["TICKET"]
if os.environ.get("TO"):
    p["to"] = os.environ["TO"]
if os.environ.get("WORK_ITEM"):
    p["workItemId"] = os.environ["WORK_ITEM"]
if os.environ.get("DECISION"):
    p["decision"] = os.environ["DECISION"]
if os.environ.get("DRIVE"):
    p["drive"] = os.environ["DRIVE"]
if os.environ.get("RECAP"):
    p["recap"] = True
print(json.dumps(p))
')

api_call POST "/chat/reply" "$BODY"
