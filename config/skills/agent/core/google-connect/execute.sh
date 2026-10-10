#!/bin/bash
# =============================================================================
# google-connect — Ask the owner to authorize a Google product, in Slack
#
# Backed by POST /api/google/connect-card, which posts a Block Kit card whose
# button opens the Cloud portal's Google page (no token in the link, and it
# never expires). Never build an authorization link by hand.
#
# Usage:
#   bash execute.sh --product gmail [--channel chat-abc123] [--account me@x.com] [--resend]
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --product <gmail|calendar|drive> [--channel <id>] [--account <email>] [--resend]

Options:
  --product   Which Google product needs access (required)
  --channel   The id in the [CHAT:...] / [SLACK-THREAD:...] header of the message you are
              answering. Optional: without it (or if it cannot be resolved) the card goes
              where you are working, else the owner's DM.
  --account   Google account to reconnect, when it matters
  --resend    The owner said the last card did not work; every call posts a fresh card
              (accepted for clarity, the flag changes nothing)
EOF_USAGE
}

PRODUCT=""
CHANNEL=""
ACCOUNT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --product) PRODUCT="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --resend) shift ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; print_usage >&2; exit 2 ;;
  esac
done

if [ -z "$PRODUCT" ]; then
  echo "--product is required." >&2
  print_usage >&2
  exit 2
fi

# Values go into JSON by hand (no jq dependency): refuse anything that could break out.
for v in "$PRODUCT" "$CHANNEL" "$ACCOUNT"; do
  case "$v" in
    *[\"\\]*|*$'\n'*) echo "Arguments must not contain quotes, backslashes or newlines." >&2; exit 2 ;;
  esac
done
BODY=$(printf '{"product":"%s"' "$PRODUCT")
[ -n "$CHANNEL" ] && BODY="${BODY},$(printf '"channelId":"%s"' "$CHANNEL")"
[ -n "$ACCOUNT" ] && BODY="${BODY},$(printf '"account":"%s"' "$ACCOUNT")"
BODY="${BODY}}"
RESPONSE=$(api_call POST "/google/connect-card" "$BODY" 2>&1) || {
  echo "$RESPONSE" >&2
  exit 1
}
echo "$RESPONSE"
