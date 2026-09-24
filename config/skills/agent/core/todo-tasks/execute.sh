#!/bin/bash
# =============================================================================
# todo-tasks — List the tasks of one Microsoft To Do list (open ones unless --all)
#
# Backed by GET /api/microsoft-todo/tasks.
#
# Usage:
#   bash execute.sh                          # open tasks of the default list ("Tasks")
#   bash execute.sh --list Groceries         # list name (case-insensitive) or id
#   bash execute.sh --list Work --all        # include completed tasks
#   bash execute.sh '{"list":"Work","limit":20}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh                          # open tasks of the default list ("Tasks")
  bash execute.sh --list Groceries         # list name (case-insensitive) or id
  bash execute.sh --list Work --all        # include completed tasks
  bash execute.sh '{"list":"Work","limit":20}'

Options:
  --list, -l    List name (case-insensitive) or id; default: the owner's default list
  --all         Include completed tasks
  --limit, -n   Result cap (default 50, max 100)
  --help | -h   Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")} + (if (.details | type) == "object" and .details.retryAfter then {retryAfter: .details.retryAfter} else {} end)' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# api_call may print a one-line warning to stderr (no CREWLY_SESSION_NAME);
# the backend answer is always the last line. On failure print the mapped
# failure JSON (fail_from) and return 1.
call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s\n' "$out" | tail -n 1)"; }
  printf '%s\n' "$out" | tail -n 1
}

INPUT_JSON=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi
LIST=""; ALL=""; LIMIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list|-l)  [ $# -ge 2 ] || error_exit "--list requires a value";  LIST="$2";  shift 2 ;;
    --all)      ALL="1"; shift ;;
    --limit|-n) [ $# -ge 2 ] || error_exit "--limit requires a value"; LIMIT="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$LIST" ]  && LIST=$(printf '%s' "$INPUT" | jq -r '.list // empty')
  [ -z "$ALL" ]   && ALL=$(printf '%s' "$INPUT" | jq -r 'if .all == true then "1" else empty end')
  [ -z "$LIMIT" ] && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
fi
QS=""
[ -n "$LIST" ]  && QS="${QS}&list=$(uri "$LIST")"
[ -n "$ALL" ]   && QS="${QS}&all=1"
[ -n "$LIMIT" ] && QS="${QS}&limit=$(uri "$LIMIT")"
QS="${QS#&}"
RESPONSE=$(call GET "/microsoft-todo/tasks${QS:+?$QS}") || { printf '%s\n' "$RESPONSE"; exit 1; }
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then printf '%s\n' "$RESPONSE"; exit 0; fi
printf '%s' "$RESPONSE" | jq -c '{list: .data.list, count: .data.count, tasks: .data.tasks} + (if .data.hasMore then {hasMore: true} else {} end)'
