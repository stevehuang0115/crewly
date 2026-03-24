#!/bin/bash
# Reply to a cross-machine message from another Crewly device
#
# Usage:
#   bash execute.sh --device <deviceId> --message "Response text"
#   echo "Response" | bash execute.sh --device <deviceId>
#   bash execute.sh '{"deviceId":"xxx","message":"Response text"}'
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT_JSON=""
DEVICE=""
DEVICE_NAME=""
MESSAGE=""
TYPE="send-message"

# Detect JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device|-d)      DEVICE="$2"; shift 2 ;;
    --device-name|-n) DEVICE_NAME="$2"; shift 2 ;;
    --message|-m)     MESSAGE="$2"; shift 2 ;;
    --type|-T)        TYPE="$2"; shift 2 ;;
    --help|-h)        echo "Usage: bash execute.sh --device <id> --message <text>"; exit 0 ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"; shift
      else
        echo '{"error":"Unknown argument: '"$1"'"}' >&2; exit 1
      fi ;;
  esac
done

# Parse JSON input
if [ -n "$INPUT_JSON" ]; then
  DEVICE=${DEVICE:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.deviceId // .device // empty')}
  DEVICE_NAME=${DEVICE_NAME:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.deviceName // empty')}
  MESSAGE=${MESSAGE:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.message // .text // empty')}
  TYPE=${TYPE:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.type // "send-message"')}
fi

# Read from stdin if no message provided
if [ -z "$MESSAGE" ] && [ ! -t 0 ]; then
  MESSAGE=$(cat)
fi

require_param "device" "$DEVICE"
require_param "message" "$MESSAGE"

# Send via Cloud API (same as send-to-remote but typed as a reply)
export _DEVICE="$DEVICE"
export _TYPE="$TYPE"
export _MESSAGE="$MESSAGE"

BODY=$(jq -n '{
  toDeviceId: env._DEVICE,
  type: "cross-machine",
  payload: {
    type: env._TYPE,
    message: env._MESSAGE
  }
}')
unset _DEVICE _TYPE _MESSAGE

api_call POST "/cloud/send" "$BODY"
