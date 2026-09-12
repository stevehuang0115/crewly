#!/bin/bash
# slack-post — send a Slack message on the agent's own initiative.
#
# Posts to a channel or opens a DM, under the calling agent's Slack identity
# (its own bot user when it has one). The shared `api_call` helper attaches
# `X-Agent-Session: $CREWLY_SESSION_NAME`, which the backend uses to pick that
# identity — without it the request is refused.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --target <#channel|@user|C…|D…|U…> --text "message" [--thread <ts>]

  echo "message" | bash execute.sh --target "#general"
  bash execute.sh --target "@steve" --text-file /tmp/report.md
  bash execute.sh '{"target":"#general","text":"hi","threadTs":"100.1"}'

Options:
  --target    | -c   Channel or person (required)
  --text      | -m   Message text (required unless piped or --text-file)
  --text-file        Read the message text from a file
  --thread    | -t   Slack thread timestamp to reply inside
  --json      | -j   Raw JSON payload
  --help      | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
TARGET=""
TEXT=""
THREAD_TS=""

# Legacy JSON as the first positional argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target|-c) TARGET="$2"; shift 2 ;;
    --text|-m) TEXT="$2"; shift 2 ;;
    --text-file) TEXT="$(cat "$2")"; shift 2 ;;
    --thread|-t) THREAD_TS="$2"; shift 2 ;;
    --json|-j) INPUT_JSON="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; print_usage >&2; exit 2 ;;
  esac
done

# Fall back to stdin for the body
if [ -z "$TEXT" ] && [ -z "$INPUT_JSON" ] && [ ! -t 0 ]; then
  TEXT="$(cat)"
fi

if [ -n "$INPUT_JSON" ]; then
  EXTRACTED=$(INPUT_JSON="$INPUT_JSON" python3 -c '
import base64, json, os, sys
try:
    d = json.loads(os.environ["INPUT_JSON"])
except Exception as e:
    print("PARSE_ERROR:" + str(e)); sys.exit(0)
print("TARGET=" + str(d.get("target", "")))
print("THREAD=" + str(d.get("threadTs", d.get("thread", ""))))
print("TEXT_B64=" + base64.b64encode(str(d.get("text", "")).encode("utf-8")).decode("ascii"))
')
  if echo "$EXTRACTED" | grep -q '^PARSE_ERROR'; then
    echo '{"success":false,"error":"invalid JSON payload"}' >&2
    exit 2
  fi
  while IFS= read -r line; do
    case "$line" in
      TARGET=*) [ -z "$TARGET" ] && TARGET="${line#TARGET=}" ;;
      THREAD=*) [ -z "$THREAD_TS" ] && THREAD_TS="${line#THREAD=}" ;;
      TEXT_B64=*) [ -z "$TEXT" ] && TEXT="$(echo "${line#TEXT_B64=}" | base64 -d 2>/dev/null)" ;;
    esac
  done <<< "$EXTRACTED"
fi

if [ -z "$TARGET" ]; then
  echo '{"success":false,"error":"--target is required (#channel, @user, or a Slack id)"}' >&2
  exit 2
fi
if [ -z "$TEXT" ]; then
  echo '{"success":false,"error":"--text is required (or pipe it via stdin)"}' >&2
  exit 2
fi
if [ -z "${CREWLY_SESSION_NAME:-}" ]; then
  echo '{"success":false,"error":"CREWLY_SESSION_NAME is unset — the post needs an agent identity"}' >&2
  exit 2
fi

# Convert literal \n to real newlines, matching the other comm skills
_NL=$'\n'; TEXT="${TEXT//\\n/$_NL}"

BODY=$(TARGET="$TARGET" TEXT="$TEXT" THREAD_TS="$THREAD_TS" python3 -c '
import json, os
p = {"target": os.environ["TARGET"], "text": os.environ["TEXT"]}
ts = os.environ.get("THREAD_TS", "")
if ts:
    p["threadTs"] = ts
print(json.dumps(p))
')

if RESPONSE=$(api_call POST "/slack/post" "$BODY" 2>&1); then
  echo "$RESPONSE" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin).get("data") or {}
except Exception:
    print("{\"success\":true}"); raise SystemExit(0)
print(json.dumps({
    "success": True,
    "channelId": d.get("channelId", ""),
    "messageTs": d.get("messageTs", ""),
    "kind": d.get("kind", ""),
    "postedAs": d.get("postedAs", ""),
}))
'
  exit 0
else
  echo "{\"success\":false,\"error\":$(echo "$RESPONSE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}"
  exit 1
fi
