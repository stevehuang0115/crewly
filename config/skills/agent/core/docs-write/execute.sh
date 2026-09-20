#!/bin/bash
# =============================================================================
# docs-write — Create a Google Doc, or append text to one Crewly created
#
# Backed by POST /api/google/docs (create) and POST /api/google/docs/:id/append.
#
# Usage:
#   bash execute.sh --title "Meeting notes" --text "…"          # create
#   bash execute.sh --title "Meeting notes" --text-file notes.md
#   bash execute.sh --id <documentId> --text "…"                  # append
#   bash execute.sh '{"title":"Meeting notes","text":"…"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --title "Meeting notes" --text "…"          # create
  bash execute.sh --title "Meeting notes" --text-file notes.md
  bash execute.sh --id <documentId> --text "…"                  # append
  bash execute.sh '{"title":"Meeting notes","text":"…"}'

Options:
  --title       Create a new document with this title
  --id          Append to this document instead (must be one Crewly created, or the grant needs the Docs scope)
  --text        Body text (plain; blank line = new paragraph)
  --text-file   Read the body from a file
  --account     Which connected Google account to act as (default: your primary)
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
TITLE=""; ID=""; TEXT=""; TEXT_FILE=""; ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)     [ $# -ge 2 ] || error_exit "--title requires a value";     TITLE="$2";     shift 2 ;;
    --id)        [ $# -ge 2 ] || error_exit "--id requires a value";        ID="$2";        shift 2 ;;
    --text)      [ $# -ge 2 ] || error_exit "--text requires a value";      TEXT="$2";      shift 2 ;;
    --text-file) [ $# -ge 2 ] || error_exit "--text-file requires a value"; TEXT_FILE="$2"; shift 2 ;;
    --account)  [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h)   print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TITLE" ] && TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  [ -z "$ID" ]    && ID=$(printf '%s' "$INPUT" | jq -r '.id // .documentId // empty')
  [ -z "$TEXT" ]  && TEXT=$(printf '%s' "$INPUT" | jq -r '.text // .body // empty')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"
if [ -n "$TEXT_FILE" ]; then
  [ -f "$TEXT_FILE" ] || error_exit "text file not found: $TEXT_FILE"
  TEXT=$(cat "$TEXT_FILE")
fi
ID=$(printf '%s' "$ID" | sed -E 's#.*/document/d/([^/?]+).*#\1#')
[ -n "$TITLE" ] || [ -n "$ID" ] || error_exit "either --title (create) or --id (append) is required"
if [ -n "$ID" ]; then
  require_param "text (--text or --text-file)" "$TEXT"
  BODY=$(jq -cn --arg text "$TEXT" '{text: $text}')
  RESPONSE=$(call POST "/google/docs/$(uri "$ID")/append" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), action: "append", id: .data.id, title: .data.title, webViewLink: .data.webViewLink}'
else
  BODY=$(jq -cn --arg title "$TITLE" --arg text "$TEXT" '{title: $title} + (if $text != "" then {text: $text} else {} end)')
  RESPONSE=$(call POST "/google/docs" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), action: "create", id: .data.id, title: .data.title, webViewLink: .data.webViewLink}'
fi
