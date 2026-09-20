#!/bin/bash
# =============================================================================
# drive-search — Search the owner's Google Drive (read-only)
#
# Backed by GET /api/google/drive/files?q=&mimeType=&folderId=&max=.
#
# Usage:
#   bash execute.sh --query "Q3 plan" [--mime doc|sheet|slides|pdf|folder|<mime>] [--folder <id>] [--max 20]
#   bash execute.sh '{"query":"Q3 plan","mime":"sheet","max":20}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --query "Q3 plan" [--mime doc|sheet|slides|pdf|folder|<mime>] [--folder <id>] [--max 20]
  bash execute.sh '{"query":"Q3 plan","mime":"sheet","max":20}'

Options:
  --query, -q   Text matched against file names and full text (empty = most recent files)
  --mime        Restrict to a type: doc | sheet | slides | pdf | folder | any MIME type
  --folder      Restrict to a Drive folder id
  --max         Result cap (default 20, max 100)
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
QUERY=""; MIME=""; FOLDER=""; MAX=""; ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query|-q) [ $# -ge 2 ] || error_exit "--query requires a value"; QUERY="$2"; shift 2 ;;
    --mime)     [ $# -ge 2 ] || error_exit "--mime requires a value";  MIME="$2";  shift 2 ;;
    --folder)   [ $# -ge 2 ] || error_exit "--folder requires a value"; FOLDER="$2"; shift 2 ;;
    --max|-n)   [ $# -ge 2 ] || error_exit "--max requires a value";   MAX="$2";   shift 2 ;;
    --account)  [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$QUERY" ]  && QUERY=$(printf '%s' "$INPUT" | jq -r '.query // .q // empty')
  [ -z "$MIME" ]   && MIME=$(printf '%s' "$INPUT" | jq -r '.mime // .mimeType // empty')
  [ -z "$FOLDER" ] && FOLDER=$(printf '%s' "$INPUT" | jq -r '.folder // .folderId // empty')
  [ -z "$MAX" ]    && MAX=$(printf '%s' "$INPUT" | jq -r '.max // empty')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"
case "$MIME" in
  doc|docs) MIME="application/vnd.google-apps.document" ;;
  sheet|sheets) MIME="application/vnd.google-apps.spreadsheet" ;;
  slides|slide|presentation) MIME="application/vnd.google-apps.presentation" ;;
  pdf) MIME="application/pdf" ;;
  folder) MIME="application/vnd.google-apps.folder" ;;
esac
QS=""
[ -n "$QUERY" ]  && QS="${QS}&q=$(uri "$QUERY")"
[ -n "$MIME" ]   && QS="${QS}&mimeType=$(uri "$MIME")"
[ -n "$FOLDER" ] && QS="${QS}&folderId=$(uri "$FOLDER")"
[ -n "$MAX" ]    && QS="${QS}&max=$(uri "$MAX")"
QS="${QS#&}"
RESPONSE=$(call GET "/google/drive/files${QS:+?$QS}") || { printf '%s\n' "$RESPONSE"; exit 1; }
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then printf '%s\n' "$RESPONSE"; exit 0; fi
printf '%s' "$RESPONSE" | jq -c '{count: .data.count, files: .data.files}'
