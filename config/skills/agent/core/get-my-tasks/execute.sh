#!/bin/bash
# Retrieve all tasks assigned to this agent session
# Supports both CLI flags (preferred) and legacy JSON argument.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred — avoids shell escaping issues)
  bash execute.sh --session dev-1 --project /path/to/project

  # Legacy JSON argument (backward compatible)
  bash execute.sh '{"sessionName":"dev-1","projectPath":"/path"}'

Options:
  --session  | -s   Agent session name (required)
  --project  | -p   Project root path (required)
  --all             Include finished tasks (verified/done/failed/cancelled). Default: open work only (#857)
  --json     | -j   Raw JSON payload (same as legacy)
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
PROJECT_PATH=""
INCLUDE_ALL="false"

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session|-s)
      SESSION_NAME="$2"
      shift 2
      ;;
    --project|-p)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --all)
      INCLUDE_ALL="true"
      shift
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"
        shift
      else
        unknown_arg_exit "$1"
      fi
      ;;
  esac
done

# If nothing provided yet but stdin has data, read it as JSON
if [ -z "$INPUT_JSON" ] && [ -z "$SESSION_NAME" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON input if provided (backward compatible)
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ "$INCLUDE_ALL" = "false" ] && INCLUDE_ALL=$(printf '%s' "$INPUT" | jq -r 'if .all == true then "true" else "false" end')
fi

require_param "sessionName (--session)" "$SESSION_NAME"
# `projectPath` is no longer required for V3 — kept in the input shape
# for backwards compat with callers who pass it.

# Per spec 2026-05-06-task-management-v1-deprecation.md, this skill now
# queries the V3 task-pool. By default it returns the WorkItems targeted at
# this agent session that are still open (#857: one startup pulled 472 items /
# 194 KB, mostly long-verified); `--all` adds the finished ones. Callers
# wanting only the running one can filter on
# `.workItems[] | select(.status=="running")`.
OPEN_STATUSES="queued,scheduled,proposed,accepted,running,blocked,escalated,done_by_worker,rejected"
ENCODED_SESSION=$(printf '%s' "$SESSION_NAME" | jq -sRr @uri)
if [ "$INCLUDE_ALL" = "true" ]; then
  api_call GET "/task-pool/items?target=${ENCODED_SESSION}"
else
  api_call GET "/task-pool/items?target=${ENCODED_SESSION}&status=${OPEN_STATUSES}"
fi
