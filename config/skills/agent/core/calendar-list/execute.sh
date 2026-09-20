#!/bin/bash
# =============================================================================
# calendar-list — Upcoming events on the owner's Google Calendar (read-only)
#
# Backed by GET /api/google/calendar/events?from=&to=&calendarId=&max=.
# Without --from/--to the window is now → now + 7 days.
#
# Usage:
#   bash execute.sh [--from ISO] [--to ISO] [--calendar id] [--max 20]
#   bash execute.sh '{"from":"…","to":"…","calendarId":"primary","max":20}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh [--from ISO-8601] [--to ISO-8601] [--calendar <id>] [--max 20]
  bash execute.sh '{"from":"…","to":"…","calendarId":"primary","max":20}'

Options:
  --from        Lower bound (default: now)
  --to          Upper bound (default: now + 7 days)
  --calendar    Calendar id (default: primary)
  --max         Result cap (default 50, max 250)
  --account     Which connected Google account to act as (default: your primary)
  --help | -h   Show this help
EOF_USAGE
}

DEFAULT_WINDOW_DAYS="${CREWLY_CALENDAR_LIST_DAYS:-7}"

# Portable "now + N days" in UTC ISO 8601 (macOS `date -v`, GNU `date -d`).
iso_now_plus_days() {
  local days="$1"
  if date -u -v+"${days}"d +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    date -u -v+"${days}"d +%Y-%m-%dT%H:%M:%SZ
  else
    date -u -d "+${days} days" +%Y-%m-%dT%H:%M:%SZ
  fi
}

INPUT_JSON=""
FROM=""; TO=""; CALENDAR=""; MAX=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)        [ $# -ge 2 ] || error_exit "--from requires a value";     FROM="$2";     shift 2 ;;
    --to)          [ $# -ge 2 ] || error_exit "--to requires a value";       TO="$2";       shift 2 ;;
    --calendar|-c) [ $# -ge 2 ] || error_exit "--calendar requires a value"; CALENDAR="$2"; shift 2 ;;
    --max|-n)      [ $# -ge 2 ] || error_exit "--max requires a value";      MAX="$2";      shift 2 ;;
    --account)  [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h)     print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$FROM" ]     && FROM=$(printf '%s' "$INPUT" | jq -r '.from // .timeMin // empty')
  [ -z "$TO" ]       && TO=$(printf '%s' "$INPUT" | jq -r '.to // .timeMax // empty')
  [ -z "$CALENDAR" ] && CALENDAR=$(printf '%s' "$INPUT" | jq -r '.calendarId // .calendar // empty')
  [ -z "$MAX" ]      && MAX=$(printf '%s' "$INPUT" | jq -r '.max // empty')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"

[ -z "$FROM" ] && FROM=$(date -u +%Y-%m-%dT%H:%M:%SZ)
[ -z "$TO" ] && TO=$(iso_now_plus_days "$DEFAULT_WINDOW_DAYS")

QS="from=$(jq -rn --arg v "$FROM" '$v|@uri')&to=$(jq -rn --arg v "$TO" '$v|@uri')"
[ -n "$CALENDAR" ] && QS="${QS}&calendarId=$(jq -rn --arg v "$CALENDAR" '$v|@uri')"
[ -n "$MAX" ] && QS="${QS}&max=$(jq -rn --arg v "$MAX" '$v|@uri')"

RESPONSE=$(api_call GET "/google/calendar/events?${QS}" 2>&1) || {
  printf '%s' "$RESPONSE" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -n --arg r "$RESPONSE" '{success: false, reason: $r}'
  exit 1
}

# Oversized bodies are parked on disk by api_call; pass that envelope through.
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then
  printf '%s\n' "$RESPONSE"; exit 0
fi

printf '%s' "$RESPONSE" | jq -c '{count: .data.count, events: .data.events}'
