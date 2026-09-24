#!/bin/bash
# =============================================================================
# todo-add — Add a task to a Microsoft To Do list
#
# Backed by POST /api/microsoft-todo/tasks.
#
# Usage:
#   bash execute.sh --title "Buy milk"                                  # default list
#   bash execute.sh --list Work --title "Send deck to Ann" --due 2026-10-01 --importance high --note "v3 in Drive"
#   bash execute.sh '{"list":"Groceries","title":"Eggs"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --title "Buy milk"                                  # default list
  bash execute.sh --list Work --title "Send deck to Ann" --due 2026-10-01 --importance high --note "v3 in Drive"
  bash execute.sh '{"list":"Groceries","title":"Eggs"}'

Options:
  --title, -t    Task title (required)
  --list, -l     List name (case-insensitive) or id; default: the owner's default list
  --due          Due date, YYYY-MM-DD
  --note         Note text shown under the task
  --importance   low | normal | high
  --help | -h    Show this help
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
TITLE=""; LIST=""; DUE=""; NOTE=""; IMPORTANCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title|-t)   [ $# -ge 2 ] || error_exit "--title requires a value";      TITLE="$2";      shift 2 ;;
    --list|-l)    [ $# -ge 2 ] || error_exit "--list requires a value";       LIST="$2";       shift 2 ;;
    --due)        [ $# -ge 2 ] || error_exit "--due requires a value";        DUE="$2";        shift 2 ;;
    --note)       [ $# -ge 2 ] || error_exit "--note requires a value";       NOTE="$2";       shift 2 ;;
    --importance) [ $# -ge 2 ] || error_exit "--importance requires a value"; IMPORTANCE="$2"; shift 2 ;;
    --help|-h)    print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TITLE" ]      && TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  [ -z "$LIST" ]       && LIST=$(printf '%s' "$INPUT" | jq -r '.list // empty')
  [ -z "$DUE" ]        && DUE=$(printf '%s' "$INPUT" | jq -r '.due // empty')
  [ -z "$NOTE" ]       && NOTE=$(printf '%s' "$INPUT" | jq -r '.note // empty')
  [ -z "$IMPORTANCE" ] && IMPORTANCE=$(printf '%s' "$INPUT" | jq -r '.importance // empty')
fi
[ -n "$TITLE" ] || error_exit "--title is required"
if [ -n "$DUE" ] && ! [[ "$DUE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then error_exit "--due must look like 2026-10-01"; fi
BODY=$(jq -cn --arg title "$TITLE" --arg list "$LIST" --arg due "$DUE" --arg note "$NOTE" --arg imp "$IMPORTANCE" \
  '{title: $title}
      + (if $list != "" then {list: $list} else {} end)
      + (if $due != "" then {due: $due} else {} end)
      + (if $note != "" then {note: $note} else {} end)
      + (if $imp != "" then {importance: $imp} else {} end)')
RESPONSE=$(call POST "/microsoft-todo/tasks" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
printf '%s' "$RESPONSE" | jq -c '{success: true, list: .data.list.name, task: .data.task}'
