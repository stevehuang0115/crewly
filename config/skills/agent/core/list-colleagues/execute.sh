#!/bin/bash
# Who can be @'d: account-wide agents (+ channel members when --channel is given).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

CHANNEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel|-c) CHANNEL="${2:-}"; shift 2 ;;
    --help|-h)
      echo "Usage: bash execute.sh [--channel <slackChannelId>]"
      exit 0 ;;
    *) shift ;;
  esac
done

ENDPOINT="/slack/directory"
if [ -n "$CHANNEL" ]; then
  ENDPOINT="/slack/directory?channel=$(printf '%s' "$CHANNEL" | tr -cd 'A-Za-z0-9')"
fi

# Test hook: print the endpoint instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "GET $ENDPOINT"
  exit 0
fi

api_call GET "$ENDPOINT"
