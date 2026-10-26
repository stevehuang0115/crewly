#!/bin/bash
# Run one short-lived in-process helper for a bounded task (crewly#1317).
# Thin wrapper over POST /api/subagents; the backend starts the worker,
# waits for its one report and shuts it down. Blocks until then.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# Wall-clock budget the backend gives a helper (600 s) plus a margin: the
# reply arrives only when the helper is done.
SUBAGENT_CURL_MAX_TIME="${CREWLY_SUBAGENT_MAX_TIME:-660}"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --task "..." [--cwd /abs/dir] [--read-only] [--max-steps N] [--model provider/id]
  bash execute.sh --task-file /path/to/task.md [...]
  bash execute.sh '{"task":"...","cwd":"/abs/dir","readOnly":true}'

Options:
  --task      | -t   The task, in full, with its acceptance line (max 12,000 chars)
  --task-file        Read the task from a file
  --cwd       | -C   Absolute directory the helper works in (default $CREWLY_PROJECT_PATH, else $PWD)
  --read-only        No shell and no file writes
  --max-steps        Model steps granted (default 30, cap 60)
  --model     | -m   provider/modelId (default: the fallback settings' in-process model)
  --json      | -j   Raw JSON payload (same as the legacy positional form)
  --help      | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
TASK=""
TASK_FILE=""
CWD_ARG=""
READ_ONLY="false"
MAX_STEPS=""
MODEL=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task|-t) TASK="${2:-}"; shift 2 ;;
    --task-file) TASK_FILE="${2:-}"; shift 2 ;;
    --cwd|-C) CWD_ARG="${2:-}"; shift 2 ;;
    --read-only) READ_ONLY="true"; shift ;;
    --max-steps) MAX_STEPS="${2:-}"; shift 2 ;;
    --model|-m) MODEL="${2:-}"; shift 2 ;;
    --json|-j) INPUT_JSON="${2:-}"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    --) shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"; shift
      else
        unknown_arg_exit "$1"
      fi
      ;;
  esac
done

if [ -z "$INPUT_JSON" ] && [ -z "$TASK" ] && [ -z "$TASK_FILE" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TASK" ] && TASK=$(printf '%s' "$INPUT" | jq -r '.task // empty')
  [ -z "$CWD_ARG" ] && CWD_ARG=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
  [ "$READ_ONLY" = "false" ] && READ_ONLY=$(printf '%s' "$INPUT" | jq -r 'if .readOnly == true then "true" else "false" end')
  [ -z "$MAX_STEPS" ] && MAX_STEPS=$(printf '%s' "$INPUT" | jq -r '.maxSteps // empty')
  [ -z "$MODEL" ] && MODEL=$(printf '%s' "$INPUT" | jq -r '.model // empty')
fi

if [ -n "$TASK_FILE" ]; then
  [ -f "$TASK_FILE" ] || error_exit "task file not found: $TASK_FILE"
  TASK="$(cat "$TASK_FILE")"
fi

require_param "task (--task)" "$TASK"

if [ -z "$CWD_ARG" ]; then
  CWD_ARG="${CREWLY_PROJECT_PATH:-$PWD}"
fi
case "$CWD_ARG" in
  /*) ;;
  *) error_exit "cwd must be an absolute path, got: $CWD_ARG" ;;
esac
[ -d "$CWD_ARG" ] || error_exit "cwd is not a directory: $CWD_ARG"

if [ -n "$MAX_STEPS" ] && ! [[ "$MAX_STEPS" =~ ^[0-9]+$ ]]; then
  error_exit "--max-steps must be a whole number, got: $MAX_STEPS"
fi

BODY=$(jq -nc \
  --arg task "$TASK" \
  --arg cwd "$CWD_ARG" \
  --argjson readOnly "$READ_ONLY" \
  --arg maxSteps "$MAX_STEPS" \
  --arg model "$MODEL" \
  '{task: $task, cwd: $cwd, readOnly: $readOnly}
   + (if $maxSteps != "" then {maxSteps: ($maxSteps | tonumber)} else {} end)
   + (if $model != "" then {model: $model} else {} end)')

# The backend wraps the outcome in {success, data}; the agent wants the outcome.
OUT=$(CREWLY_API_MAX_TIME="$SUBAGENT_CURL_MAX_TIME" api_call POST "/subagents" "$BODY")
printf '%s' "$OUT" | jq -c '.data // .'
