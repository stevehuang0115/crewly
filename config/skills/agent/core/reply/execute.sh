#!/bin/bash
# reply — answer the message you are working on. The harness sends it back
# where that message came from (Slack DM, Slack room thread, portal / Talk
# chat) — no channel ids, no choosing between reply-channel / reply-chat /
# reply-slack. Status lines ([DONE], [BLOCKED], …) still go to the
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

Options:
  --text | -t        Reply text (or the first positional argument, or stdin)
  --text-file        Read the reply from a file
  --interim          A short note before the real answer; "working on it" stays up
  --none             Nothing to answer (already answered elsewhere / not for you)
  --conversation|-C  Only if your prompt tells you to answer somewhere specific
  --thread | -T      Only if your prompt tells you to answer in a specific thread
  --help | -h        Show this help
EOF_USAGE
}

TEXT=""
INTERIM=""
NONE=""
CONVERSATION_ID=""
THREAD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --text|-t) TEXT="$2"; shift 2 ;;
    --text-file) TEXT="$(cat "$2")"; shift 2 ;;
    --content|-m) TEXT="$2"; shift 2 ;;
    --interim) INTERIM="1"; shift ;;
    --none) NONE="1"; shift ;;
    --conversation|-C|--channel|-c) CONVERSATION_ID="$2"; shift 2 ;;
    --thread|-T) THREAD="$2"; shift 2 ;;
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

BODY=$(TEXT="$TEXT" INTERIM="$INTERIM" NONE="$NONE" CONVERSATION_ID="$CONVERSATION_ID" THREAD="$THREAD" python3 -c '
import os, json
p = {}
if os.environ.get("NONE"):
    p["none"] = True
else:
    p["content"] = os.environ["TEXT"]
if os.environ.get("INTERIM"):
    p["interim"] = True
if os.environ.get("CONVERSATION_ID"):
    p["conversationId"] = os.environ["CONVERSATION_ID"]
if os.environ.get("THREAD"):
    p["thread"] = os.environ["THREAD"]
print(json.dumps(p))
')

api_call POST "/chat/reply" "$BODY"
