#!/bin/bash
# Show or choose the account's primary machine (an account setting kept by Crewly Cloud)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"show|set|clear\",\"machine\":\"mac-mini\"}'"
ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')

case "$ACTION" in
  show)
    api_call GET "/slack/cloud/machines"
    ;;
  set)
    MACHINE=$(printf '%s' "$INPUT" | jq -r '.machine // empty')
    require_param "machine" "$MACHINE"
    BODY=$(jq -n --arg m "$MACHINE" '{machine: $m}')
    api_call PUT "/slack/cloud/primary" "$BODY"
    ;;
  clear)
    api_call PUT "/slack/cloud/primary" '{"machine":null}'
    ;;
  *)
    error_exit "Unknown action: ${ACTION}. Use show | set | clear"
    ;;
esac
