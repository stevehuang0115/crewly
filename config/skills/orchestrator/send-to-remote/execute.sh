#!/bin/bash
# Send a cross-machine message to a remote Crewly instance via Cloud API
#
# Usage:
#   bash execute.sh '{"targetMachine":"device-uuid","type":"delegate-task","message":"Run tests"}'
#   bash execute.sh --target device-uuid --type delegate-task --message "Run tests"
#
# Parameters:
#   targetMachine / --target   Target device ID (required)
#   type / --type              Message type: delegate-task|send-message|status-request|ping (required)
#   message / --message        Message text (optional, included in payload)
#   payload / --payload        JSON payload string (optional)
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT_JSON=""
TARGET=""
TYPE=""
MESSAGE=""
PAYLOAD=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target|-t)  TARGET="$2"; shift 2 ;;
    --type|-T)    TYPE="$2"; shift 2 ;;
    --message|-m) MESSAGE="$2"; shift 2 ;;
    --payload|-p) PAYLOAD="$2"; shift 2 ;;
    --help|-h)    echo "Usage: bash execute.sh --target <deviceId> --type <type> [--message <text>]"; exit 0 ;;
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
  TARGET=${TARGET:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.targetMachine // empty')}
  TYPE=${TYPE:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.type // empty')}
  MESSAGE=${MESSAGE:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.message // empty')}
  PAYLOAD=${PAYLOAD:-$(printf '%s\n' "$INPUT_JSON" | jq -r '.payload // empty')}
fi

require_param "targetMachine" "$TARGET"
require_param "type" "$TYPE"

# Build the Cloud API request body
# Uses /api/cloud/send which routes through CloudSyncService (no Slack dependency)
export _TARGET="$TARGET"
export _TYPE="$TYPE"
export _MESSAGE="${MESSAGE:-}"

if [ -n "$PAYLOAD" ] && [ "$PAYLOAD" != "null" ]; then
  export _PAYLOAD="$PAYLOAD"
  BODY=$(jq -n '{
    toDeviceId: env._TARGET,
    type: "cross-machine",
    payload: {
      type: env._TYPE,
      message: (if env._MESSAGE != "" then env._MESSAGE else null end),
      data: (env._PAYLOAD | fromjson)
    } | with_entries(select(.value != null))
  }')
  unset _PAYLOAD
else
  BODY=$(jq -n '{
    toDeviceId: env._TARGET,
    type: "cross-machine",
    payload: {
      type: env._TYPE,
      message: (if env._MESSAGE != "" then env._MESSAGE else null end)
    } | with_entries(select(.value != null))
  }')
fi
unset _TARGET _TYPE _MESSAGE

api_call POST "/cloud/send" "$BODY"
