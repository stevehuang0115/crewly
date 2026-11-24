#!/bin/bash
# Channel notes: what a shared room is for, who leads it and who covers what.
# Read the page, or record what a person said about it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

CHANNEL=""
ARGS=()
CHANGED=""
NOTES_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel|-c) CHANNEL="${2:-}"; shift 2 ;;
    --lead) ARGS+=(--arg lead "${2:-}"); CHANGED="1"; shift 2 ;;
    --purpose) ARGS+=(--arg purpose "${2:-}"); CHANGED="1"; shift 2 ;;
    --cover) ARGS+=(--arg cover "${2:-}"); CHANGED="1"; shift 2 ;;
    --uncover) ARGS+=(--arg uncover "${2:-}"); CHANGED="1"; shift 2 ;;
    --notes) ARGS+=(--arg notes "${2:-}"); CHANGED="1"; shift 2 ;;
    --notes-file) NOTES_FILE="${2:-}"; CHANGED="1"; shift 2 ;;
    --help|-h)
      echo "Usage: bash execute.sh --channel <id|#name> [--lead <name>] [--cover \"<name>: <what>\"]"
      echo "                       [--uncover <name>] [--purpose <text>] [--notes <text> | --notes-file <path>]"
      echo "  With --channel alone: prints the room's page."
      echo "  --lead \"\" clears the lead; --notes replaces the Notes section."
      exit 0 ;;
    *) unknown_arg_exit "$1" ;;
  esac
done

if [ -z "$CHANNEL" ]; then
  echo '{"success":false,"error":"--channel is required: the room id from the [CHAT:<id>] line of the message, or its #name"}' >&2
  exit 2
fi
if [ -n "$NOTES_FILE" ]; then
  if [ ! -f "$NOTES_FILE" ]; then
    echo "{\"success\":false,\"error\":\"No file at ${NOTES_FILE}\"}" >&2
    exit 2
  fi
  ARGS+=(--rawfile notes "$NOTES_FILE")
fi

ENDPOINT="/channel-notes/$(jq -rn --arg c "$CHANNEL" '$c|@uri')"

if [ -z "$CHANGED" ]; then
  if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then echo "GET $ENDPOINT"; exit 0; fi
  api_call GET "$ENDPOINT"
  exit 0
fi

BODY=$(jq -nc "${ARGS[@]}" '$ARGS.named')
# Test hook: print the request instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "POST $ENDPOINT $BODY"
  exit 0
fi
api_call POST "$ENDPOINT" "$BODY"
