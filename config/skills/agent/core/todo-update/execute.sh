#!/bin/bash
# =============================================================================
# todo-update — Complete, reopen, edit or delete a Microsoft To Do task
#
# Backed by PATCH / DELETE /api/microsoft-todo/tasks/:taskId.
#
# Usage:
#   bash execute.sh --list Groceries --task <taskId> --complete
#   bash execute.sh --list Work --task <taskId> --title "Send v4 deck" --due 2026-10-03
#   bash execute.sh --list Work --task <taskId> --due none          # clear the due date
#   bash execute.sh --list Work --task <taskId> --reopen
#   bash execute.sh --list Work --task <taskId> --delete
#   bash execute.sh '{"list":"Work","task":"AAMk…","complete":true}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --list Groceries --task <taskId> --complete
  bash execute.sh --list Work --task <taskId> --title "Send v4 deck" --due 2026-10-03
  bash execute.sh --list Work --task <taskId> --due none          # clear the due date
  bash execute.sh --list Work --task <taskId> --reopen
  bash execute.sh --list Work --task <taskId> --delete
  bash execute.sh '{"list":"Work","task":"AAMk…","complete":true}'

Options:
  --task         Task id from todo-tasks (required)
  --list, -l     List name (case-insensitive) or id the task is in; default: the owner's default list
  --complete     Mark the task completed
  --reopen       Mark a completed task not started again
  --title        New title
  --due          New due date YYYY-MM-DD, or "none" to clear it
  --note         Replace the note
  --importance   low | normal | high
  --delete       Delete the task (cannot be undone)
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
TASK=""; LIST=""; COMPLETE=""; TITLE=""; DUE=""; NOTE=""; IMPORTANCE=""; DELETE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)       [ $# -ge 2 ] || error_exit "--task requires a value";       TASK="$2";       shift 2 ;;
    --list|-l)    [ $# -ge 2 ] || error_exit "--list requires a value";       LIST="$2";       shift 2 ;;
    --complete)   COMPLETE="true"; shift ;;
    --reopen)     COMPLETE="false"; shift ;;
    --title)      [ $# -ge 2 ] || error_exit "--title requires a value";      TITLE="$2";      shift 2 ;;
    --due)        [ $# -ge 2 ] || error_exit "--due requires a value";        DUE="$2";        shift 2 ;;
    --note)       [ $# -ge 2 ] || error_exit "--note requires a value";       NOTE="$2";       shift 2 ;;
    --importance) [ $# -ge 2 ] || error_exit "--importance requires a value"; IMPORTANCE="$2"; shift 2 ;;
    --delete)     DELETE="1"; shift ;;
    --help|-h)    print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TASK" ]       && TASK=$(printf '%s' "$INPUT" | jq -r '.task // .taskId // .id // empty')
  [ -z "$LIST" ]       && LIST=$(printf '%s' "$INPUT" | jq -r '.list // empty')
  [ -z "$COMPLETE" ]   && COMPLETE=$(printf '%s' "$INPUT" | jq -r 'if .complete == true then "true" elif .reopen == true then "false" else empty end')
  [ -z "$TITLE" ]      && TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  [ -z "$DUE" ]        && DUE=$(printf '%s' "$INPUT" | jq -r '.due // empty')
  [ -z "$NOTE" ]       && NOTE=$(printf '%s' "$INPUT" | jq -r '.note // empty')
  [ -z "$IMPORTANCE" ] && IMPORTANCE=$(printf '%s' "$INPUT" | jq -r '.importance // empty')
  [ -z "$DELETE" ]     && DELETE=$(printf '%s' "$INPUT" | jq -r 'if .delete == true then "1" else empty end')
fi
[ -n "$TASK" ] || error_exit "--task is required (ids come from todo-tasks)"
if [ -n "$DELETE" ]; then
  QS=""
  [ -n "$LIST" ] && QS="?list=$(uri "$LIST")"
  RESPONSE=$(call DELETE "/microsoft-todo/tasks/$(uri "$TASK")${QS}") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: true, deleted: true, list: .data.list.name, taskId: .data.taskId}'
  exit 0
fi
if [ -n "$DUE" ] && [ "$DUE" != "none" ] && ! [[ "$DUE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  error_exit "--due must look like 2026-10-01, or none to clear it"
fi
if [ -z "$COMPLETE" ] && [ -z "$TITLE" ] && [ -z "$DUE" ] && [ -z "$NOTE" ] && [ -z "$IMPORTANCE" ]; then
  error_exit "nothing to change: give --complete, --reopen, --title, --due, --note, --importance or --delete"
fi
BODY=$(jq -cn --arg list "$LIST" --arg complete "$COMPLETE" --arg title "$TITLE" --arg due "$DUE" --arg note "$NOTE" --arg imp "$IMPORTANCE" \
  '{}
      + (if $list != "" then {list: $list} else {} end)
      + (if $complete != "" then {complete: ($complete == "true")} else {} end)
      + (if $title != "" then {title: $title} else {} end)
      + (if $due == "none" then {due: null} elif $due != "" then {due: $due} else {} end)
      + (if $note != "" then {note: $note} else {} end)
      + (if $imp != "" then {importance: $imp} else {} end)')
RESPONSE=$(call PATCH "/microsoft-todo/tasks/$(uri "$TASK")" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
printf '%s' "$RESPONSE" | jq -c '{success: true, list: .data.list.name, task: .data.task}'
