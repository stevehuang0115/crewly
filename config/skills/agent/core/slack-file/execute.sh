#!/bin/bash
# slack-file — get a Slack file by link or id (also one your own bot cannot see).
#
# Backed by POST /api/slack/files/fetch: this machine's bot tokens first, then
# Crewly Cloud (every bot of the account).
#
# Usage: execute.sh get <link|file id> [--out <path>]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../../_common/lib.sh"

usage() {
  cat <<'USAGE'
slack-file — get a Slack file by link or id

  get <link|id>   File link (https://<ws>.slack.com/files/...), file id (F...),
                  download URL, or a message link carrying a file   (required)
  --out <path>    Also copy the file to this path
USAGE
}

CMD=""; REF=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    get) CMD="get"; REF="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --out|-o) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) if [ -z "$REF" ] && [ "$CMD" = "get" ]; then REF="$1"; shift; else echo "{\"error\":\"Unknown argument: $1\"}" >&2; exit 1; fi ;;
  esac
done

if [ "$CMD" != "get" ] || [ -z "$REF" ]; then
  echo '{"error":"Usage: execute.sh get <link|file id> [--out <path>]"}' >&2
  usage >&2
  exit 1
fi

# Slack mrkdwn links arrive as <url|label>; the backend unwraps them too.
BODY=$(jq -cn --arg fileRef "$REF" '{fileRef: $fileRef}')

# Test hook: print the request instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "POST /slack/files/fetch $BODY"
  exit 0
fi

if ! RESPONSE=$(api_call POST "/slack/files/fetch" "$BODY" 2>&1); then
  echo "$RESPONSE" >&2
  exit 1
fi

FILE_PATH=$(printf '%s' "$RESPONSE" | jq -r '.data.path // empty')
if [ -z "$FILE_PATH" ]; then
  echo "$RESPONSE" >&2
  exit 1
fi

if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")"
  cp "$FILE_PATH" "$OUT"
  FILE_PATH="$OUT"
fi

printf '%s' "$RESPONSE" | jq --arg path "$FILE_PATH" '{
  path: $path,
  name: .data.file.name,
  mimetype: .data.file.mimetype,
  size: .data.file.size,
  via: .data.file.via
} + (if .data.preview then {preview: .data.preview} else {} end)
  + (if (.data.file.otherFileIds // []) | length > 0 then {otherFileIds: .data.file.otherFileIds} else {} end)'
