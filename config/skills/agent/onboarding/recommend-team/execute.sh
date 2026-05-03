#!/bin/bash
# Recommend a team configuration based on the user's business context.
# Wraps POST /api/orchestrator/onboarding/recommend-team. Onboarding-only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
INDUSTRY=""
SCALE=""
TASKS_JSON=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --industry|-i)
      INDUSTRY="$2"
      shift 2
      ;;
    --scale|-s)
      SCALE="$2"
      shift 2
      ;;
    --tasks|-t)
      TASKS_JSON="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
Usage: execute.sh --industry "<text>" --scale solo|small-team|company \\
                  --tasks '[{"name":"…","tier":"yes-today"}]'

Or:    execute.sh '{"industry":"…","scale":"solo","tasks":[…]}'

Tier values: yes-today | collaborative | roadmap | out-of-scope
EOF
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
        error_exit "Unknown argument: $1"
      fi
      ;;
  esac
done

# Read from stdin if nothing else supplied
if [ -z "$INPUT_JSON" ] && [ -z "$INDUSTRY" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided — flag-based fields take priority
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$INDUSTRY" ]   && INDUSTRY=$(printf '%s' "$INPUT" | jq -r '.industry // empty')
  [ -z "$SCALE" ]      && SCALE=$(printf '%s' "$INPUT" | jq -r '.scale // empty')
  [ -z "$TASKS_JSON" ] && TASKS_JSON=$(printf '%s' "$INPUT" | jq -c '.tasks // empty')
fi

require_param "industry (--industry)" "$INDUSTRY"
require_param "scale (--scale)" "$SCALE"
[ -z "$TASKS_JSON" ] && TASKS_JSON='[]'

# Build request body via env vars (safe-escape)
export _RT_INDUSTRY="$INDUSTRY"
export _RT_SCALE="$SCALE"
export _RT_TASKS="$TASKS_JSON"

BODY=$(jq -n '{
  industry: env._RT_INDUSTRY,
  scale: env._RT_SCALE,
  tasks: (env._RT_TASKS | fromjson)
}')

unset _RT_INDUSTRY _RT_SCALE _RT_TASKS

api_call POST "/orchestrator/onboarding/recommend-team" "$BODY"
