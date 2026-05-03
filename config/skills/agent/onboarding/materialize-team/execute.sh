#!/bin/bash
# Materialize a confirmed team recommendation: write the team config and flip
# the project onboardingComplete flag. Onboarding-only.
# Wraps POST /api/orchestrator/onboarding/materialize-team.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
RECOMMENDATION=""
TEAMS_DIR=""
PROJECT_FLAG_PATH=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --recommendation|-r)
      RECOMMENDATION="$2"
      shift 2
      ;;
    --teams-dir)
      TEAMS_DIR="$2"
      shift 2
      ;;
    --project-flag-path)
      PROJECT_FLAG_PATH="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
Usage: execute.sh --recommendation '<json>' \\
                  [--teams-dir <path>] [--project-flag-path <path>]

Or pipe a full request via stdin / --json:
  {"recommendation": {...}, "teamsDir": "...", "projectFlagPath": "..."}

The "recommendation" payload is the JSON object returned from
the recommend-team skill (templateId + agents + reasoning + source).
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

# Read from stdin if nothing else
if [ -z "$INPUT_JSON" ] && [ -z "$RECOMMENDATION" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON wrapper if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  if [ -z "$RECOMMENDATION" ]; then
    REC_FROM_JSON=$(printf '%s' "$INPUT" | jq -c '.recommendation // empty')
    [ -n "$REC_FROM_JSON" ] && RECOMMENDATION="$REC_FROM_JSON"
  fi
  [ -z "$TEAMS_DIR" ]          && TEAMS_DIR=$(printf '%s' "$INPUT" | jq -r '.teamsDir // empty')
  [ -z "$PROJECT_FLAG_PATH" ]  && PROJECT_FLAG_PATH=$(printf '%s' "$INPUT" | jq -r '.projectFlagPath // empty')
fi

require_param "recommendation (--recommendation)" "$RECOMMENDATION"

export _MT_REC="$RECOMMENDATION"
BODY=$(jq -n '{recommendation: (env._MT_REC | fromjson)}')
unset _MT_REC

if [ -n "$TEAMS_DIR" ]; then
  BODY=$(echo "$BODY" | jq --arg p "$TEAMS_DIR" '. + {teamsDir: $p}')
fi
if [ -n "$PROJECT_FLAG_PATH" ]; then
  BODY=$(echo "$BODY" | jq --arg p "$PROJECT_FLAG_PATH" '. + {projectFlagPath: $p}')
fi

api_call POST "/orchestrator/onboarding/materialize-team" "$BODY"
