#!/bin/bash
# =============================================================================
# docs-read — Read a Google Doc as plain text (headings, bullets, tables kept)
#
# Backed by GET /api/google/docs/:id.
#
# Usage:
#   bash execute.sh --id <documentId>
#   bash execute.sh '{"id":"<documentId>"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id <documentId>
  bash execute.sh '{"id":"<documentId>"}'

Options:
  --id          Document id (from drive-search or the docs.google.com URL)
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
ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)      [ $# -ge 2 ] || error_exit "--id requires a value"; ID="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ID" ] && ID=$(printf '%s' "$INPUT" | jq -r '.id // .documentId // empty')
fi
# Accept a full docs.google.com URL too.
ID=$(printf '%s' "$ID" | sed -E 's#.*/document/d/([^/?]+).*#\1#')
require_param "id (--id)" "$ID"
RESPONSE=$(call GET "/google/docs/$(uri "$ID")") || { printf '%s\n' "$RESPONSE"; exit 1; }
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then printf '%s\n' "$RESPONSE"; exit 0; fi
printf '%s' "$RESPONSE" | jq -c '{id: .data.id, title: .data.title, webViewLink: .data.webViewLink, text: .data.text}'
