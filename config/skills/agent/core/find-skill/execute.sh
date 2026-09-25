#!/bin/bash
# =============================================================================
# find-skill — find a skill that gives you a capability you lack.
#
# Searches the skills bundled with Crewly, installed marketplace skills and
# the marketplace registry by capability, name, tags and description.
# Backed by GET /api/skill-setup/find.
#
# Usage:
#   bash execute.sh --query "transcribe a voice message"
#   bash execute.sh --query "read a pdf" --limit 3
#   bash execute.sh '{"query":"…"}'
#
# Output: {success, query, candidates:[{id, name, official, officialReason,
#   installed, ready, setup:{declared, estimatedMinutes, satisfied, missing},
#   executePath, …}], registryAvailable, next}
# `next` says what to do: use it, install it (official), or ask the owner.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --query "transcribe a voice message" [--limit 5]
  bash execute.sh '{"query":"…","limit":5}'

Options:
  --query | -q   What you need, in plain words (required)
  --limit        Maximum candidates (default 8)
  --help  | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""; QUERY=""; LIMIT=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query|-q) [ $# -ge 2 ] || error_exit "--query requires a value"; QUERY="$2"; shift 2 ;;
    --limit)    [ $# -ge 2 ] || error_exit "--limit requires a value"; LIMIT="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$QUERY" ] && QUERY=$(printf '%s' "$INPUT" | jq -r '.query // empty')
  [ -z "$LIMIT" ] && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
fi
require_param "query (--query)" "$QUERY"
[ -z "$LIMIT" ] || [[ "$LIMIT" =~ ^[0-9]+$ ]] || error_exit "--limit must be a number"

ENDPOINT="/skill-setup/find?query=$(printf '%s' "$QUERY" | jq -sRr @uri)"
[ -n "$LIMIT" ] && ENDPOINT="${ENDPOINT}&limit=${LIMIT}"

ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call GET "$ENDPOINT" 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{success: false, error: (.details.error // .error // "find failed")}' 2>/dev/null \
    || jq -cn --arg e "$ERR" '{success: false, error: $e}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '.data | {success: true, query, next, registryAvailable,
  candidates: [.candidates[] | {id, name, description: (.description | .[0:200]), official, officialReason,
    installed, ready, setup, executePath, source}]}'
