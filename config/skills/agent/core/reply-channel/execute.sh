#!/bin/bash
# reply-channel — post an agent-authored reply to a chat channel.
# Used by the Chat MVP dispatch loop: the runtime hands the agent a prompt
# prefixed `[CHAT:<channelId>]`; the agent processes it, then invokes this
# skill to write its reply back to the channel.
#
# The shared `api_call` helper attaches `X-Agent-Session: $CREWLY_SESSION_NAME`
# automatically, which the chat-v2 controller uses to route the message as
# `senderType:"agent"` instead of `user`.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --channel <channelId> --content "reply text" [--thread <messageId>] [--cmid <clientMessageId>]

  # Content from stdin
  echo "multi-line reply" | bash execute.sh --channel chan-1

  # JSON
  bash execute.sh '{"channelId":"chan-1","content":"hi","clientMessageId":"cmid-abc"}'

Options:
  --channel   | -c   Target channel id, or '#name' of a Crewly channel
                     (see list-channels) — required
  --content   | -m   Reply text (required unless piped via stdin)
  --content-file     Read reply text from a file path
  --thread    | -t   Thread root message id — reply inside that thread
                     (Slack team channels: keeps the reply in the same Slack thread)
  --cmid             Optional client-message-id for idempotency
  --interim          This is a short note before the real answer (what you
                     understood, how you'll do it, roughly how long). It is
                     posted, the "working on it…" line comes back under it,
                     and your final reply replaces that line. Use it for jobs
                     that take more than a few minutes; skip it for quick ones.
  --working          Say you are taking this on, without replying yet: shows
                     "<you> is working on it…" in the Slack thread, which your
                     real reply then replaces. Use it when a message was only
                     passed to you to judge, and you have decided to answer.
  --new-thread       A deliberate new top-level post in a Slack team room. Without
                     --thread or --new-thread such a post is refused there
                     (409 thread_required), never put at the top level silently.
  --adds-new         Post even though the agent chosen to answer the owner
                     already replied in this thread -- when you have something
                     new, or when you were asked (without it such a post is
                     held and you are shown the existing answer).
  --file      | -f   Attach a file for a colleague on another machine (repeatable,
                     up to 5, inside your project). It reaches their inbox
                     automatically. A path you write in the text of a message
                     to a room with another machine's agent goes the same way.
  --handoff NAME     Pass the message to another agent to answer, wherever it
                     runs — for a room's router (an orchestrator woken because
                     nobody in a private channel was awake). Posts nothing.
  --message ID       With --handoff: the message to pass on (from your prompt)
  --json      | -j   Raw JSON payload
  --help      | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
CHANNEL_ID=""
CONTENT=""
CMID=""
THREAD_ID=""
WORKING=""
HANDOFF=""
MESSAGE_REF=""
ADDS_NEW=""
NEW_THREAD=""
FILES_JSON="[]"

# Detect legacy JSON argument as $1
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel|-c)
      CHANNEL_ID="$2"
      shift 2
      ;;
    --working)
      WORKING="1"
      shift
      ;;
    --interim)
      INTERIM="1"
      shift
      ;;
    --adds-new)
      ADDS_NEW="1"
      shift
      ;;
    --new-thread)
      NEW_THREAD="1"
      shift
      ;;
    --handoff)
      HANDOFF="$2"
      shift 2
      ;;
    --message)
      MESSAGE_REF="$2"
      shift 2
      ;;
    --file|-f)
      [ $# -ge 2 ] || { echo '{"success":false,"error":"--file requires a path"}' >&2; exit 2; }
      FILES_JSON=$(FILES_JSON="$FILES_JSON" NEW_FILE="$2" python3 -c 'import json, os; a = json.loads(os.environ["FILES_JSON"]); a.append(os.environ["NEW_FILE"]); print(json.dumps(a))')
      shift 2
      ;;
    --content|-m)
      CONTENT="$2"
      shift 2
      ;;
    --content-file)
      CONTENT="$(cat "$2")"
      shift 2
      ;;
    --cmid)
      CMID="$2"
      shift 2
      ;;
    --thread|-t)
      THREAD_ID="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      print_usage >&2
      unknown_arg_exit "$1"
      ;;
  esac
done

# Fall back to stdin when --content and legacy JSON are both missing
if [ -z "$CONTENT" ] && [ -z "$INPUT_JSON" ] && [ ! -t 0 ]; then
  CONTENT="$(cat)"
fi

# When given JSON, extract fields via python (portable — awk/sed + json is fragile)
if [ -n "$INPUT_JSON" ]; then
  if command -v python3 >/dev/null 2>&1; then
    EXTRACTED=$(python3 - <<PY
import json, sys
try:
    d = json.loads('''$INPUT_JSON''')
except Exception as e:
    print('PARSE_ERROR:' + str(e))
    sys.exit(0)
print('CHANNEL=' + str(d.get('channelId', '')))
print('CMID=' + str(d.get('clientMessageId', '')))
print('THREAD=' + str(d.get('threadId', '')))
print('INTERIM=' + ('1' if d.get('interim') is True else ''))
# content is multi-line safe — use base64
import base64
c = d.get('content', '')
print('CONTENT_B64=' + base64.b64encode(c.encode('utf-8')).decode('ascii'))
PY
)
    if echo "$EXTRACTED" | grep -q '^PARSE_ERROR'; then
      echo '{"success":false,"error":"invalid JSON payload"}' >&2
      exit 2
    fi
    while IFS= read -r line; do
      case "$line" in
        CHANNEL=*) [ -z "$CHANNEL_ID" ] && CHANNEL_ID="${line#CHANNEL=}";;
        CMID=*) [ -z "$CMID" ] && CMID="${line#CMID=}";;
        THREAD=*) [ -z "$THREAD_ID" ] && THREAD_ID="${line#THREAD=}";;
        INTERIM=*) [ -z "${INTERIM:-}" ] && INTERIM="${line#INTERIM=}";;
        CONTENT_B64=*) [ -z "$CONTENT" ] && CONTENT="$(echo "${line#CONTENT_B64=}" | base64 -d 2>/dev/null)";;
      esac
    done <<< "$EXTRACTED"
  else
    echo '{"success":false,"error":"python3 required to parse JSON payload"}' >&2
    exit 2
  fi
fi

if [ -z "$CHANNEL_ID" ]; then
  echo '{"success":false,"error":"--channel is required"}' >&2
  exit 2
fi

# A Crewly channel by name ('#tech-brief'): look its id up first.
if [[ "$CHANNEL_ID" == \#* ]]; then
  REF_ENC=$(REF="$CHANNEL_ID" python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["REF"], safe=""))')
  if ! LOOKUP=$(api_call GET "/channels/${REF_ENC}" 2>&1); then
    echo "{\"success\":false,\"error\":\"No channel ${CHANNEL_ID} — run list-channels to see yours\"}" >&2
    exit 1
  fi
  RESOLVED=$(printf '%s' "$LOOKUP" | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin).get("data") or {}).get("id", ""))
except Exception:
    pass
' 2>/dev/null || true)
  if [ -z "$RESOLVED" ]; then
    echo "{\"success\":false,\"error\":\"No channel ${CHANNEL_ID} — run list-channels to see yours\"}" >&2
    exit 1
  fi
  CHANNEL_ID="$RESOLVED"
fi

# Hand the message to the agent that should answer it, and stop.
if [ -n "$HANDOFF" ]; then
  HBODY=$(THREAD_ID="$THREAD_ID" CHANNEL_ID="$CHANNEL_ID" HANDOFF="$HANDOFF" MESSAGE_REF="$MESSAGE_REF" python3 -c '
import os, json
p = {"channelId": os.environ["CHANNEL_ID"], "name": os.environ["HANDOFF"]}
for env, key in (("THREAD_ID", "threadId"), ("MESSAGE_REF", "messageId")):
    v = os.environ.get(env, "")
    if v:
        p[key] = v
print(json.dumps(p))
')
  if RESPONSE=$(api_call POST "/slack/handoff" "$HBODY" 2>&1); then
    echo "$RESPONSE"
    exit 0
  fi
  echo "$RESPONSE" >&2
  exit 1
fi

# "I'm taking this on": post the working-on-it placeholder and stop. The
# reply sent afterwards (same --channel and --thread) replaces it in place.
if [ -n "$WORKING" ]; then
  WBODY=$(THREAD_ID="$THREAD_ID" CHANNEL_ID="$CHANNEL_ID" python3 -c '
import os, json
p = {"channelId": os.environ["CHANNEL_ID"]}
t = os.environ.get("THREAD_ID", "")
if t:
    p["threadId"] = t
print(json.dumps(p))
')
  if RESPONSE=$(api_call POST "/slack/working" "$WBODY" 2>&1); then
    echo "$RESPONSE"
    exit 0
  fi
  echo "$RESPONSE" >&2
  exit 1
fi

if [ -z "$CONTENT" ]; then
  echo '{"success":false,"error":"--content is required (or pipe via stdin)"}' >&2
  exit 2
fi

# Build JSON body. Export CONTENT/CMID so python can read them safely without
# quoting the values through the shell (avoids escaping hell for multi-line
# content with quotes, backslashes, backticks, etc.).
BODY=$(CONTENT="$CONTENT" CMID="$CMID" THREAD_ID="$THREAD_ID" INTERIM="${INTERIM:-}" ADDS_NEW="$ADDS_NEW" NEW_THREAD="$NEW_THREAD" FILES_JSON="$FILES_JSON" PROJECT_PATH="${CREWLY_PROJECT_PATH:-$PWD}" python3 -c '
import os, json
p = {"content": os.environ["CONTENT"], "contentType": "markdown"}
files = json.loads(os.environ.get("FILES_JSON", "[]"))
if files:
    p["files"] = files
# Where relative paths in the text resolve and the file guard is anchored.
p["projectPath"] = os.environ.get("PROJECT_PATH", "")
if os.environ.get("INTERIM"):
    p["interim"] = True
if os.environ.get("ADDS_NEW"):
    p["addsNew"] = True
if os.environ.get("NEW_THREAD"):
    p["newThread"] = True
cmid = os.environ.get("CMID", "")
if cmid:
    p["clientMessageId"] = cmid
thread = os.environ.get("THREAD_ID", "")
if thread:
    p["threadId"] = thread
print(json.dumps(p))
')

ENDPOINT="/chat/channels/${CHANNEL_ID}/messages"

if RESPONSE=$(api_call POST "$ENDPOINT" "$BODY" 2>&1); then
  # Successful 2xx — surface the message id, plus what happened to any files
  echo "$RESPONSE" | CHANNEL_ID="$CHANNEL_ID" python3 -c '
import json, os, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print(json.dumps({"success": True, "channelId": os.environ["CHANNEL_ID"], "raw": raw}, separators=(",", ":")))
    raise SystemExit(0)
data = d.get("data") or {}
if data.get("deliveredPrivately"):
    # R6: an agents-only post never lands in the owner thread; it went to the agents.
    print(json.dumps({"success": True, "posted": False, "deliveredPrivately": True, "to": data.get("to", []), "note": data.get("note", "")}, separators=(",", ":"), ensure_ascii=False))
    raise SystemExit(0)
mid = data.get("id", "")
out = {"success": True}
if mid:
    out["messageId"] = mid
else:
    out["raw"] = raw
out["channelId"] = os.environ["CHANNEL_ID"]
fh = d.get("fileHandoff") or {}
if fh.get("attached"):
    out["filesSent"] = [a.get("fileName") for a in fh["attached"]]
if fh.get("failed"):
    out["filesNotSent"] = fh["failed"]
    out["warning"] = "The message was posted, but these files did not go (" + "; ".join(str(f.get("file")) + ": " + str(f.get("reason")) for f in fh["failed"]) + "). Tell your colleague, or fix it and send the file again with --file."
print(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
'
  exit 0
else
  echo "{\"success\":false,\"error\":$(echo "$RESPONSE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}"
  exit 1
fi
