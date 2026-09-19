#!/bin/bash
# =============================================================================
# sheets-write — Create a Google Sheet, or append/overwrite rows in one Crewly created
#
# Backed by POST /api/google/sheets (create) and POST /api/google/sheets/:id/values.
#
# Usage:
#   bash execute.sh --title "Leads" --rows '[["name","email"],["Ann","a@x"]]' [--sheet "Raw"]
#   bash execute.sh --title "Leads" --csv-file leads.csv
#   bash execute.sh --id <spreadsheetId> --rows '[["Bob","b@x"]]' [--range "Raw!A1"]            # append
#   bash execute.sh --id <spreadsheetId> --rows '[["v"]]' --range "Raw!B2" --mode update       # overwrite
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --title "Leads" --rows '[["name","email"],["Ann","a@x"]]' [--sheet "Raw"]
  bash execute.sh --title "Leads" --csv-file leads.csv
  bash execute.sh --id <spreadsheetId> --rows '[["Bob","b@x"]]' [--range "Raw!A1"]            # append
  bash execute.sh --id <spreadsheetId> --rows '[["v"]]' --range "Raw!B2" --mode update       # overwrite

Options:
  --title       Create a new spreadsheet with this title
  --sheet       Name of the first tab when creating (default Sheet1)
  --id          Write into this spreadsheet instead (must be one Crewly created, or the grant needs the Sheets scope)
  --rows        JSON array of arrays (strings / numbers / booleans)
  --csv-file    Rows from a CSV file (simple: comma-separated, quotes stripped)
  --range       A1 anchor: the table to append to, or the top-left cell to overwrite (default A1)
  --mode        append (default) | update
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
TITLE=""; SHEET=""; ID=""; ROWS=""; CSV_FILE=""; RANGE=""; MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)    [ $# -ge 2 ] || error_exit "--title requires a value";    TITLE="$2";    shift 2 ;;
    --sheet)    [ $# -ge 2 ] || error_exit "--sheet requires a value";    SHEET="$2";    shift 2 ;;
    --id)       [ $# -ge 2 ] || error_exit "--id requires a value";       ID="$2";       shift 2 ;;
    --rows)     [ $# -ge 2 ] || error_exit "--rows requires a value";     ROWS="$2";     shift 2 ;;
    --csv-file) [ $# -ge 2 ] || error_exit "--csv-file requires a value"; CSV_FILE="$2"; shift 2 ;;
    --range)    [ $# -ge 2 ] || error_exit "--range requires a value";    RANGE="$2";    shift 2 ;;
    --mode)     [ $# -ge 2 ] || error_exit "--mode requires a value";     MODE="$2";     shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TITLE" ] && TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  [ -z "$SHEET" ] && SHEET=$(printf '%s' "$INPUT" | jq -r '.sheet // .sheetTitle // empty')
  [ -z "$ID" ]    && ID=$(printf '%s' "$INPUT" | jq -r '.id // .spreadsheetId // empty')
  [ -z "$ROWS" ]  && ROWS=$(printf '%s' "$INPUT" | jq -c '.rows // empty')
  [ -z "$RANGE" ] && RANGE=$(printf '%s' "$INPUT" | jq -r '.range // empty')
  [ -z "$MODE" ]  && MODE=$(printf '%s' "$INPUT" | jq -r '.mode // empty')
fi
if [ -n "$CSV_FILE" ]; then
  [ -f "$CSV_FILE" ] || error_exit "csv file not found: $CSV_FILE"
  ROWS=$(python3 -c 'import csv,json,sys; print(json.dumps(list(csv.reader(open(sys.argv[1], newline="")))))' "$CSV_FILE")
fi
ID=$(printf '%s' "$ID" | sed -E 's#.*/spreadsheets/d/([^/?]+).*#\1#')
[ -n "$TITLE" ] || [ -n "$ID" ] || error_exit "either --title (create) or --id (write) is required"
[ -z "$ROWS" ] || printf '%s' "$ROWS" | jq -e 'type == "array" and all(.[]; type == "array")' >/dev/null 2>&1 || error_exit "--rows must be a JSON array of arrays"
case "$MODE" in ""|append|update) ;; *) error_exit "--mode must be append or update" ;; esac
if [ -n "$ID" ]; then
  require_param "rows (--rows or --csv-file)" "$ROWS"
  BODY=$(jq -cn --argjson rows "$ROWS" --arg range "$RANGE" --arg mode "${MODE:-append}" \
    '{rows: $rows, mode: $mode} + (if $range != "" then {range: $range} else {} end)')
  RESPONSE=$(call POST "/google/sheets/$(uri "$ID")/values" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), action: .data.mode, spreadsheetId: .data.spreadsheetId, updatedRange: .data.updatedRange, updatedRows: .data.updatedRows}'
else
  BODY=$(jq -cn --arg title "$TITLE" --arg sheet "$SHEET" --argjson rows "${ROWS:-[]}" \
    '{title: $title} + (if $sheet != "" then {sheetTitle: $sheet} else {} end) + (if ($rows|length) > 0 then {rows: $rows} else {} end)')
  RESPONSE=$(call POST "/google/sheets" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), action: "create", id: .data.id, title: .data.title, sheets: [.data.sheets[]?.title], webViewLink: .data.webViewLink}'
fi
