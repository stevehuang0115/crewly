#!/bin/bash
# =============================================================================
# calendar-create — Create an event on the owner's Google Calendar
#
# Backed by POST /api/google/calendar/events.
#
# Usage:
#   bash execute.sh --summary "Review" --start 2026-09-20T14:00:00 --end 2026-09-20T15:00:00
#                   [--timezone Asia/Shanghai] [--description "…"] [--attendee a@b.c]... [--calendar id]
#   bash execute.sh '{"summary":"Review","start":"…","end":"…","attendees":["a@b.c"]}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --summary "Review" --start <ISO|YYYY-MM-DD> --end <ISO|YYYY-MM-DD>
                  [--timezone Asia/Shanghai] [--description "…"] [--attendee a@b.c]... [--calendar <id>]
  bash execute.sh '{"summary":"Review","start":"…","end":"…","attendees":["a@b.c"]}'

Options:
  --summary       Event title (required)
  --start         Start: ISO 8601 date-time, or YYYY-MM-DD for all-day (required)
  --end           End: ISO 8601 date-time, or YYYY-MM-DD (exclusive) for all-day (required)
  --timezone      IANA zone for start/end without an offset
  --description   Body text
  --attendee      Attendee email (repeat for several)
  --calendar      Calendar id (default: primary)
  --help | -h     Show this help
EOF_USAGE
}

INPUT_JSON=""
SUMMARY=""; START=""; END=""; TIMEZONE=""; DESCRIPTION=""; CALENDAR=""
ATTENDEES_JSON='[]'

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary|--title) [ $# -ge 2 ] || error_exit "--summary requires a value";     SUMMARY="$2";     shift 2 ;;
    --start)           [ $# -ge 2 ] || error_exit "--start requires a value";       START="$2";       shift 2 ;;
    --end)             [ $# -ge 2 ] || error_exit "--end requires a value";         END="$2";         shift 2 ;;
    --timezone|--tz)   [ $# -ge 2 ] || error_exit "--timezone requires a value";    TIMEZONE="$2";    shift 2 ;;
    --description)     [ $# -ge 2 ] || error_exit "--description requires a value"; DESCRIPTION="$2"; shift 2 ;;
    --calendar|-c)     [ $# -ge 2 ] || error_exit "--calendar requires a value";    CALENDAR="$2";    shift 2 ;;
    --attendee)        [ $# -ge 2 ] || error_exit "--attendee requires a value"
                       ATTENDEES_JSON=$(jq -cn --argjson arr "$ATTENDEES_JSON" --arg v "$2" '$arr + [$v]'); shift 2 ;;
    --help|-h)         print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$SUMMARY" ]     && SUMMARY=$(printf '%s' "$INPUT" | jq -r '.summary // .title // empty')
  [ -z "$START" ]       && START=$(printf '%s' "$INPUT" | jq -r '.start // empty')
  [ -z "$END" ]         && END=$(printf '%s' "$INPUT" | jq -r '.end // empty')
  [ -z "$TIMEZONE" ]    && TIMEZONE=$(printf '%s' "$INPUT" | jq -r '.timezone // .timeZone // empty')
  [ -z "$DESCRIPTION" ] && DESCRIPTION=$(printf '%s' "$INPUT" | jq -r '.description // empty')
  [ -z "$CALENDAR" ]    && CALENDAR=$(printf '%s' "$INPUT" | jq -r '.calendarId // .calendar // empty')
  if [ "$(printf '%s' "$ATTENDEES_JSON" | jq 'length')" -eq 0 ]; then
    ATTENDEES_JSON=$(printf '%s' "$INPUT" | jq -c '(.attendees // []) | if type == "string" then split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "")) else . end')
  fi
fi

require_param "summary (--summary)" "$SUMMARY"
require_param "start (--start)" "$START"
require_param "end (--end)" "$END"

BODY=$(jq -cn --arg summary "$SUMMARY" --arg start "$START" --arg end "$END" \
  --arg timezone "$TIMEZONE" --arg description "$DESCRIPTION" --arg calendarId "$CALENDAR" \
  --argjson attendees "$ATTENDEES_JSON" \
  '{summary: $summary, start: $start, end: $end}
   + (if $timezone != "" then {timezone: $timezone} else {} end)
   + (if $description != "" then {description: $description} else {} end)
   + (if $calendarId != "" then {calendarId: $calendarId} else {} end)
   + (if ($attendees | length) > 0 then {attendees: $attendees} else {} end)')

RESPONSE=$(api_call POST "/google/calendar/events" "$BODY" 2>&1) || {
  printf '%s' "$RESPONSE" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -n --arg r "$RESPONSE" '{success: false, reason: $r}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '{success: (.success // false)} + (.data | {id, summary, start, end, htmlLink, attendees})'
