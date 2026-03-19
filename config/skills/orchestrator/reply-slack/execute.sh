#!/bin/bash
# Send a message to a Slack channel or thread via the backend API
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # Legacy JSON argument
  bash execute.sh '{"channelId":"C0123","text":"Hello"}'

  # Flag-based invocation with multi-line text from stdin
  cat message.txt | bash execute.sh --channel C0123

  # Upload an image with optional comment
  bash execute.sh --channel C0123 --image /path/to/screenshot.png --text "Here's the result"

  # Upload any file type (PDF, CSV, etc.) with optional comment
  bash execute.sh --channel C0123 --file /path/to/report.pdf --text "Daily report"

Options:
  --channel | -c   Slack channel ID (required unless JSON provided)
  --text    | -t   Message text (optional when piping stdin)
  --text-file     Read message text from the specified file path
  --thread  | -r   Slack thread timestamp for replies
  --image   | -i   Path to image file to upload (uses /api/slack/upload-image)
  --file    | -f   Path to file upload (uses /api/slack/upload-file)
  --allow-new-thread  Allow posting without --thread (disabled by default for safety)
  --json    | -j   Raw JSON payload (same as legacy usage)
  --help    | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
CHANNEL_ID=""
TEXT=""
THREAD_TS=""
IMAGE_PATH=""
FILE_PATH=""
ALLOW_NEW_THREAD="false"

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

CONVERSATION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel|-c)
      CHANNEL_ID="$2"
      shift 2
      ;;
    --text|-t)
      TEXT="$2"
      shift 2
      ;;
    --text-file)
      TEXT="$(cat "$2")"
      shift 2
      ;;
    --thread|-r)
      THREAD_TS="$2"
      shift 2
      ;;
    --image|-i)
      IMAGE_PATH="$2"
      shift 2
      ;;
    --file|-f)
      FILE_PATH="$2"
      shift 2
      ;;
    --allow-new-thread)
      ALLOW_NEW_THREAD="true"
      shift
      ;;
    --conversation|-C)
      CONVERSATION_ID="$2"
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
    --)
      shift
      break
      ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"
        shift
      else
        error_exit "Unknown argument: $1"
      fi
      ;;
  esac
done

# If nothing provided yet, but stdin has data, read it
if [ -z "$INPUT_JSON" ] && [ -z "$TEXT" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    TEXT="$STDIN_DATA"
  fi
fi

if [ -n "$INPUT_JSON" ]; then
  # Use printf instead of echo to avoid interpretation of escape sequences (#205, #206)
  CHANNEL_ID=${CHANNEL_ID:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.channelId // empty')}
  TEXT=${TEXT:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.text // empty')}
  THREAD_TS=${THREAD_TS:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.threadTs // empty')}
  CONVERSATION_ID=${CONVERSATION_ID:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.conversationId // empty')}
  FILE_PATH=${FILE_PATH:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.file // .filePath // empty')}
  IMAGE_PATH=${IMAGE_PATH:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.image // .imagePath // empty')}
fi

require_param "channelId" "$CHANNEL_ID"

# Convert literal \n sequences to real newlines.
# This fixes a common issue where callers pass text through JSON.stringify()
# which escapes newlines to literal \n characters that Slack displays as text.
if [ -n "$TEXT" ]; then
  _NL=$'\n'
  TEXT="${TEXT//\\n/$_NL}"
fi

# Auto-prefix with session name so Slack messages are attributable.
# Uses CREWLY_SESSION_NAME env var (set by the runtime for all agent sessions).
if [ -n "${CREWLY_SESSION_NAME:-}" ] && [ -n "$TEXT" ]; then
  # Extract display name from session format: "crewly-{team}-{name}-{uuid}" → {Name}
  # Fallback: "crewly-orc" → "Orc"
  IFS='-' read -ra _PARTS <<< "$CREWLY_SESSION_NAME"
  if [ ${#_PARTS[@]} -ge 3 ]; then
    _NAME_PART="${_PARTS[2]}"
  else
    _NAME_PART="${_PARTS[${#_PARTS[@]}-1]}"
  fi
  _CAPITALIZED="$(echo "${_NAME_PART:0:1}" | tr '[:lower:]' '[:upper:]')${_NAME_PART:1}"
  # Only prefix if not already prefixed (avoid double-prefix on retries)
  if [[ "$TEXT" != "["* ]]; then
    TEXT="[${_CAPITALIZED}] ${TEXT}"
  fi
fi

# Prevent ambiguous uploads.
if [ -n "$IMAGE_PATH" ] && [ -n "$FILE_PATH" ]; then
  error_exit "Use either --image or --file, not both."
fi

# When uploading an image/file, text is optional (serves as initial_comment)
if [ -z "$IMAGE_PATH" ] && [ -z "$FILE_PATH" ] && [ -z "$TEXT" ]; then
  error_exit "Slack message text is required. Pass --text, --text-file, pipe stdin, or include it in the JSON payload."
fi

# Safety default: require explicit thread targeting to avoid accidental
# top-level replies when a threaded reply was intended.
if [ -z "$THREAD_TS" ] && [ "$ALLOW_NEW_THREAD" != "true" ]; then
  error_exit "threadTs is required to prevent accidental new-thread posts. Pass --thread <ts> (or --allow-new-thread to override)."
fi

if [ -n "$IMAGE_PATH" ]; then
  # Image upload mode — use /api/slack/upload-image
  BODY=$(jq -n \
    --arg channelId "$CHANNEL_ID" \
    --arg filePath "$IMAGE_PATH" \
    --arg initialComment "${TEXT:-}" \
    --arg threadTs "${THREAD_TS:-}" \
    '{channelId: $channelId, filePath: $filePath} +
     (if $initialComment != "" then {initialComment: $initialComment} else {} end) +
     (if $threadTs != "" then {threadTs: $threadTs} else {} end)')

  api_call POST "/slack/upload-image" "$BODY"
elif [ -n "$FILE_PATH" ]; then
  # Generic file upload mode — use /api/slack/upload-file
  BODY=$(jq -n \
    --arg channelId "$CHANNEL_ID" \
    --arg filePath "$FILE_PATH" \
    --arg initialComment "${TEXT:-}" \
    --arg threadTs "${THREAD_TS:-}" \
    '{channelId: $channelId, filePath: $filePath} +
     (if $initialComment != "" then {initialComment: $initialComment} else {} end) +
     (if $threadTs != "" then {threadTs: $threadTs} else {} end)')

  api_call POST "/slack/upload-file" "$BODY"
else
  # Text-only mode — use /api/slack/send
  # Use env vars to avoid shell escaping issues with backticks, quotes, markdown (#205, #206)
  export _SLACK_CHANNEL="$CHANNEL_ID"
  export _SLACK_TEXT="$TEXT"
  if [ -n "$THREAD_TS" ]; then
    export _SLACK_THREAD="$THREAD_TS"
    BODY=$(jq -n '{channelId: env._SLACK_CHANNEL, text: env._SLACK_TEXT, threadTs: env._SLACK_THREAD}')
    unset _SLACK_THREAD
  else
    BODY=$(jq -n '{channelId: env._SLACK_CHANNEL, text: env._SLACK_TEXT}')
  fi
  unset _SLACK_CHANNEL _SLACK_TEXT

  api_call POST "/slack/send" "$BODY"
fi
