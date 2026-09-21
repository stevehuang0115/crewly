#!/bin/bash
# =============================================================================
# google-connect — Ask the owner to authorize a Google product, in Slack
#
# Backed by POST /api/google/connect-card, which posts a Block Kit card whose
# button carries a single-use ticket. Never build an authorization link by
# hand: the one this instance can build embeds the Cloud session token.
#
# Usage:
#   bash execute.sh --product gmail --channel chat-abc123
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --product <gmail|calendar|drive> --channel <chat-channel-id>

Options:
  --product   Which Google product needs access (required)
  --channel   The chat channel you are answering in — the id in [CHAT:…] (required)
EOF_USAGE
}

PRODUCT=""
CHANNEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --product) PRODUCT="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; print_usage >&2; exit 2 ;;
  esac
done

if [ -z "$PRODUCT" ] || [ -z "$CHANNEL" ]; then
  echo "Both --product and --channel are required." >&2
  print_usage >&2
  exit 2
fi

BODY=$(printf '{"product":"%s","channelId":"%s"}' "$PRODUCT" "$CHANNEL")
RESPONSE=$(api_call POST "/google/connect-card" "$BODY" 2>&1) || {
  echo "$RESPONSE" >&2
  exit 1
}
echo "$RESPONSE"
