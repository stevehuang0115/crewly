#!/bin/bash
# The Crewly channels you are in (or every channel with --all): rooms shared
# with agents of other teams, each matched to a Slack channel when Slack is on.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

ALL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all|-a) ALL="1"; shift ;;
    --help|-h)
      echo "Usage: bash execute.sh [--all]"
      echo "  Lists the channels you are a member of; --all lists every channel."
      echo "  Post in one with: reply-channel --channel '#name' --content \"...\""
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ENDPOINT="/channels"
if [ -z "$ALL" ]; then
  if [ -z "${CREWLY_SESSION_NAME:-}" ]; then
    echo '{"success":false,"error":"CREWLY_SESSION_NAME is not set — pass --all, or prefix the call with CREWLY_SESSION_NAME=<your session name>"}' >&2
    exit 2
  fi
  ENDPOINT="/channels?member=$(printf '%s' "$CREWLY_SESSION_NAME" | tr -cd 'A-Za-z0-9._-')"
fi

# Test hook: print the endpoint instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "GET $ENDPOINT"
  exit 0
fi

api_call GET "$ENDPOINT"
