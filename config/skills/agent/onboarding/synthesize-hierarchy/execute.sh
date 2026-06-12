#!/bin/bash
# Plan (default) or materialize (--materialize) a nested team hierarchy for a
# complex multi-stream goal. Wraps:
#   POST /api/orchestrator/onboarding/synthesize-hierarchy   (plan — pure)
#   POST /api/orchestrator/onboarding/materialize-hierarchy  (create — after approval)
# Onboarding-only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INDUSTRY=""
SCALE=""
TASKS_JSON=""
MAX_SUBTEAMS=""
PLAN_JSON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --industry|-i)    INDUSTRY="$2"; shift 2 ;;
    --scale|-s)       SCALE="$2"; shift 2 ;;
    --tasks|-t)       TASKS_JSON="$2"; shift 2 ;;
    --max-subteams)   MAX_SUBTEAMS="$2"; shift 2 ;;
    --materialize|-m) PLAN_JSON="$2"; shift 2 ;;
    --help|-h)
      cat <<HELP
Plan:        execute.sh --industry "<goal text>" --scale solo|small-team|company [--tasks '[{"name":"…","tier":"yes-today"}]'] [--max-subteams N]
Materialize: execute.sh --materialize '<plan JSON from the plan step>'
HELP
      exit 0
      ;;
    *) error_exit "Unknown argument: $1" ;;
  esac
done

if [ -n "$PLAN_JSON" ]; then
  # Materialize an approved plan.
  export _SH_PLAN="$PLAN_JSON"
  BODY=$(jq -n '{ plan: (env._SH_PLAN | fromjson) }')
  unset _SH_PLAN
  api_call POST "/orchestrator/onboarding/materialize-hierarchy" "$BODY"
  exit 0
fi

require_param "industry (--industry)" "$INDUSTRY"
require_param "scale (--scale)" "$SCALE"
[ -z "$TASKS_JSON" ] && TASKS_JSON='[]'

export _SH_INDUSTRY="$INDUSTRY"
export _SH_SCALE="$SCALE"
export _SH_TASKS="$TASKS_JSON"
export _SH_MAX="${MAX_SUBTEAMS:-}"

BODY=$(jq -n '{
  industry: env._SH_INDUSTRY,
  scale: env._SH_SCALE,
  tasks: (env._SH_TASKS | fromjson)
} + (if env._SH_MAX != "" then { maxSubteams: (env._SH_MAX | tonumber) } else {} end)')

unset _SH_INDUSTRY _SH_SCALE _SH_TASKS _SH_MAX

api_call POST "/orchestrator/onboarding/synthesize-hierarchy" "$BODY"
