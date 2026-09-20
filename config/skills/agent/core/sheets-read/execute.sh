#!/bin/bash
# =============================================================================
# sheets-read — Read cells (or the tab list) of a Google Sheet
#
# Backed by GET /api/google/sheets/:id/values?range= and GET /api/google/sheets/:id.
#
# Usage:
#   bash execute.sh --id <spreadsheetId> [--range "Sheet1!A1:D50"]
#   bash execute.sh --id <spreadsheetId> --info          # title + tabs only
#   bash execute.sh '{"id":"<spreadsheetId>","range":"A1:D50"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id <spreadsheetId> [--range "Sheet1!A1:D50"]
  bash execute.sh --id <spreadsheetId> --info          # title + tabs only
  bash execute.sh '{"id":"<spreadsheetId>","range":"A1:D50"}'

Options:
  --id          Spreadsheet id (or its URL)
  --range       A1 range, e.g. "Q3!A1:D50" (default A1:Z1000 on the first tab)
  --info        Print the title and tab names instead of values
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
ID=""; RANGE=""; INFO=""; ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)      [ $# -ge 2 ] || error_exit "--id requires a value";    ID="$2";    shift 2 ;;
    --range)   [ $# -ge 2 ] || error_exit "--range requires a value"; RANGE="$2"; shift 2 ;;
    --info)    INFO=1; shift ;;
    --account)  [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ID" ]    && ID=$(printf '%s' "$INPUT" | jq -r '.id // .spreadsheetId // empty')
  [ -z "$RANGE" ] && RANGE=$(printf '%s' "$INPUT" | jq -r '.range // empty')
  [ -z "$INFO" ]  && INFO=$(printf '%s' "$INPUT" | jq -r 'if .info == true then "1" else "" end')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"
ID=$(printf '%s' "$ID" | sed -E 's#.*/spreadsheets/d/([^/?]+).*#\1#')
require_param "id (--id)" "$ID"
if [ -n "$INFO" ]; then
  RESPONSE=$(call GET "/google/sheets/$(uri "$ID")") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '.data'
  exit 0
fi
QS=""; [ -n "$RANGE" ] && QS="?range=$(uri "$RANGE")"
RESPONSE=$(call GET "/google/sheets/$(uri "$ID")/values${QS}") || { printf '%s\n' "$RESPONSE"; exit 1; }
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then printf '%s\n' "$RESPONSE"; exit 0; fi
printf '%s' "$RESPONSE" | jq -c '{spreadsheetId: .data.spreadsheetId, range: .data.range, rowCount: (.data.rows | length), rows: .data.rows}'
