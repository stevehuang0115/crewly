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
  bash execute.sh --channel <channelId> --content "reply text" [--cmid <clientMessageId>]

  # Content from stdin
  echo "multi-line reply" | bash execute.sh --channel chan-1

  # JSON
  bash execute.sh '{"channelId":"chan-1","content":"hi","clientMessageId":"cmid-abc"}'

Options:
  --channel   | -c   Target channel id (required)
  --content   | -m   Reply text (required unless piped via stdin)
  --content-file     Read reply text from a file path
  --cmid             Optional client-message-id for idempotency
  --json      | -j   Raw JSON payload
  --help      | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
CHANNEL_ID=""
CONTENT=""
CMID=""

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
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_usage >&2
      exit 2
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

if [ -z "$CONTENT" ]; then
  echo '{"success":false,"error":"--content is required (or pipe via stdin)"}' >&2
  exit 2
fi

# Build JSON body. Export CONTENT/CMID so python can read them safely without
# quoting the values through the shell (avoids escaping hell for multi-line
# content with quotes, backslashes, backticks, etc.).
BODY=$(CONTENT="$CONTENT" CMID="$CMID" python3 -c '
import os, json
p = {"content": os.environ["CONTENT"], "contentType": "markdown"}
cmid = os.environ.get("CMID", "")
if cmid:
    p["clientMessageId"] = cmid
print(json.dumps(p))
')

ENDPOINT="/chat/channels/${CHANNEL_ID}/messages"

if RESPONSE=$(api_call POST "$ENDPOINT" "$BODY" 2>&1); then
  # Successful 2xx — surface the message id
  MESSAGE_ID=$(echo "$RESPONSE" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print((d.get("data") or {}).get("id",""))
except Exception:
    pass
' 2>/dev/null || echo "")
  if [ -n "$MESSAGE_ID" ]; then
    echo "{\"success\":true,\"messageId\":\"$MESSAGE_ID\",\"channelId\":\"$CHANNEL_ID\"}"
  else
    # Success code but unexpected body — still return success with raw response
    echo "{\"success\":true,\"channelId\":\"$CHANNEL_ID\",\"raw\":$(echo "$RESPONSE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}"
  fi
  exit 0
else
  echo "{\"success\":false,\"error\":$(echo "$RESPONSE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}"
  exit 1
fi
