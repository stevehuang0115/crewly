#!/usr/bin/env bash
# attach-file — put a real file into the Slack channel you are replying in.
#
# Backed by POST /api/slack/attach. Takes the CHAT channel id (the one in your
# prompt), not a Slack channel id: the backend resolves the Slack channel, the
# thread and your bot identity from it.
#
# Usage: execute.sh --channel <chatChannelId> --path <file> [--name <n>]
#                   [--title <t>] [--comment <c>] [--thread <messageId>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../../_common/lib.sh"

CHANNEL=""; FILE_PATH=""; NAME=""; TITLE=""; COMMENT=""; THREAD=""

usage() {
  cat <<'USAGE'
attach-file — send a file into your Slack channel

  --channel <id>   Chat channel id from your prompt ([CHAT:<id>])   (required)
  --path <file>    Absolute path of the file to send                (required)
  --name <name>    Filename to show in Slack
  --title <title>  Title shown above the file
  --comment <text> A line of text posted with the file
  --thread <id>    Reply inside this thread
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --channel|-c) CHANNEL="${2:-}"; shift 2 ;;
    --path|-p)    FILE_PATH="${2:-}"; shift 2 ;;
    --name)       NAME="${2:-}"; shift 2 ;;
    --title)      TITLE="${2:-}"; shift 2 ;;
    --comment|-m) COMMENT="${2:-}"; shift 2 ;;
    --thread|-t)  THREAD="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "{\"error\":\"Unknown argument: $1\"}" >&2; exit 1 ;;
  esac
done

if [ -z "$CHANNEL" ] || [ -z "$FILE_PATH" ]; then
  echo '{"error":"Missing required parameter: --channel and --path"}' >&2
  usage >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo "{\"error\":\"No such file: $FILE_PATH\"}" >&2
  exit 1
fi

BODY=$(jq -cn \
  --arg channelId "$CHANNEL" \
  --arg filePath "$FILE_PATH" \
  --arg filename "$NAME" \
  --arg title "$TITLE" \
  --arg comment "$COMMENT" \
  --arg threadId "$THREAD" \
  '{channelId: $channelId, filePath: $filePath}
   + (if $filename != "" then {filename: $filename} else {} end)
   + (if $title    != "" then {title: $title}       else {} end)
   + (if $comment  != "" then {comment: $comment}   else {} end)
   + (if $threadId != "" then {threadId: $threadId} else {} end)')

if RESPONSE=$(api_call POST "/slack/attach" "$BODY" 2>&1); then
  echo "$RESPONSE"
else
  echo "$RESPONSE" >&2
  exit 1
fi
