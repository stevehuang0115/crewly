#!/bin/bash
# Record the team lead's rung for a correction class (#810).
#   execute.sh --project <root> --class <slug> --rung <structural|check|hook|prose> --reason '<why>' [--link <url>] [--by <session>]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT_JSON=""
PROJECT_PATH=""
CLASS=""
RUNG=""
REASON=""
LINK=""
BY="${CREWLY_SESSION_NAME:-}"

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p) PROJECT_PATH="$2"; shift 2 ;;
    --class|-c) CLASS="$2"; shift 2 ;;
    --rung|-r) RUNG="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --link) LINK="$2"; shift 2 ;;
    --by) BY="$2"; shift 2 ;;
    --json|-j) INPUT_JSON="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --project <root> --class <slug> --rung <structural|check|hook|prose> --reason '<why>' [--link <url>] [--by <session>]"
      exit 0
      ;;
    *) unknown_arg_exit "$1" ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ -z "$CLASS" ] && CLASS=$(printf '%s' "$INPUT" | jq -r '.correctionClass // empty')
  [ -z "$RUNG" ] && RUNG=$(printf '%s' "$INPUT" | jq -r '.rung // empty')
  [ -z "$REASON" ] && REASON=$(printf '%s' "$INPUT" | jq -r '.reason // empty')
  [ -z "$LINK" ] && LINK=$(printf '%s' "$INPUT" | jq -r '.link // empty')
  [ -z "$BY" ] && BY=$(printf '%s' "$INPUT" | jq -r '.decidedBy // empty')
fi

require_param "projectPath (--project)" "$PROJECT_PATH"
require_param "correctionClass (--class)" "$CLASS"
require_param "rung (--rung)" "$RUNG"
require_param "reason (--reason)" "$REASON"
[ -z "$BY" ] && BY="team-leader"

case "$RUNG" in
  structural|check|hook|prose) ;;
  *) error_exit "rung must be one of structural, check, hook, prose (got: $RUNG)" ;;
esac

export _DC_PROJECT="$PROJECT_PATH" _DC_RUNG="$RUNG" _DC_REASON="$REASON" _DC_LINK="$LINK" _DC_BY="$BY"
BODY=$(jq -n '{projectPath: env._DC_PROJECT, rung: env._DC_RUNG, reason: env._DC_REASON, decidedBy: env._DC_BY} + (if env._DC_LINK != "" then {link: env._DC_LINK} else {} end)')
unset _DC_PROJECT _DC_RUNG _DC_REASON _DC_LINK _DC_BY

api_call POST "/memory/corrections/$(printf '%s' "$CLASS" | jq -sRr @uri | tr -d '\n')/decide" "$BODY"
