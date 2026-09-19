#!/bin/bash
# =============================================================================
# canva-designs — List / search the owner's Canva designs, or fetch one (edit + view links)
#
# Backed by GET /api/canva/designs and GET /api/canva/designs/:id.
#
# Usage:
#   bash execute.sh [--query "poster"] [--owned|--shared] [--sort modified_descending] [--limit 25]
#   bash execute.sh --id <designId>
#   bash execute.sh '{"query":"poster","limit":10}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh [--query "poster"] [--owned|--shared] [--sort modified_descending] [--limit 25]
  bash execute.sh --id <designId>
  bash execute.sh '{"query":"poster","limit":10}'

Options:
  --query, -q   Text to search design titles
  --id          Fetch one design instead of listing
  --owned       Only designs the owner created (default: any)
  --shared      Only designs shared with the owner
  --sort        relevance | modified_descending | modified_ascending | title_descending | title_ascending
  --limit       Result cap (default 25, max 100)
  --continuation  Token from a previous page
  --help | -h   Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# api_call may print a one-line warning to stderr (no CREWLY_SESSION_NAME);
# the backend answer is always the last line. On failure print the mapped
# failure JSON (fail_from) and return 1.
call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s
' "$out" | tail -n 1)"; }
  printf '%s
' "$out" | tail -n 1
}

INPUT_JSON=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi
QUERY=""; ID=""; OWNERSHIP=""; SORT=""; LIMIT=""; CONT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query|-q)     [ $# -ge 2 ] || error_exit "--query requires a value"; QUERY="$2"; shift 2 ;;
    --id)           [ $# -ge 2 ] || error_exit "--id requires a value";    ID="$2";    shift 2 ;;
    --owned)        OWNERSHIP="owned"; shift ;;
    --shared)       OWNERSHIP="shared"; shift ;;
    --sort)         [ $# -ge 2 ] || error_exit "--sort requires a value";  SORT="$2";  shift 2 ;;
    --limit|-n)     [ $# -ge 2 ] || error_exit "--limit requires a value"; LIMIT="$2"; shift 2 ;;
    --continuation) [ $# -ge 2 ] || error_exit "--continuation requires a value"; CONT="$2"; shift 2 ;;
    --help|-h)      print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$QUERY" ]     && QUERY=$(printf '%s' "$INPUT" | jq -r '.query // .q // empty')
  [ -z "$ID" ]        && ID=$(printf '%s' "$INPUT" | jq -r '.id // .designId // empty')
  [ -z "$OWNERSHIP" ] && OWNERSHIP=$(printf '%s' "$INPUT" | jq -r '.ownership // empty')
  [ -z "$SORT" ]      && SORT=$(printf '%s' "$INPUT" | jq -r '.sort // .sortBy // empty')
  [ -z "$LIMIT" ]     && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
  [ -z "$CONT" ]      && CONT=$(printf '%s' "$INPUT" | jq -r '.continuation // empty')
fi
if [ -n "$ID" ]; then
  RESPONSE=$(call GET "/canva/designs/$(uri "$ID")") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '.data'
  exit 0
fi
QS=""
[ -n "$QUERY" ]     && QS="${QS}&q=$(uri "$QUERY")"
[ -n "$OWNERSHIP" ] && QS="${QS}&ownership=$(uri "$OWNERSHIP")"
[ -n "$SORT" ]      && QS="${QS}&sort=$(uri "$SORT")"
[ -n "$LIMIT" ]     && QS="${QS}&limit=$(uri "$LIMIT")"
[ -n "$CONT" ]      && QS="${QS}&continuation=$(uri "$CONT")"
QS="${QS#&}"
RESPONSE=$(call GET "/canva/designs${QS:+?$QS}") || { printf '%s\n' "$RESPONSE"; exit 1; }
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then printf '%s\n' "$RESPONSE"; exit 0; fi
printf '%s' "$RESPONSE" | jq -c '{count: .data.count, designs: .data.designs} + (if .data.continuation then {continuation: .data.continuation} else {} end)'
