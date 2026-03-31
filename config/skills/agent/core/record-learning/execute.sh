#!/bin/bash
# Record a learning or insight for team knowledge sharing.
# Supports CLI flags (preferred) and legacy JSON.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
AGENT_ID=""
AGENT_ROLE=""
PROJECT_PATH=""
LEARNING=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent|-a)
      AGENT_ID="$2"
      shift 2
      ;;
    --role|-r)
      AGENT_ROLE="$2"
      shift 2
      ;;
    --project|-p)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --learning|-l)
      LEARNING="$2"
      shift 2
      ;;
    --learning-file)
      LEARNING="$(cat "$2")"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: execute.sh --agent dev-1 --role developer --project /path --learning 'What I learned'"
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

# Read from stdin if no learning yet
if [ -z "$INPUT_JSON" ] && [ -z "$LEARNING" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    LEARNING="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$AGENT_ID" ] && AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
  [ -z "$AGENT_ROLE" ] && AGENT_ROLE=$(printf '%s' "$INPUT" | jq -r '.agentRole // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ -z "$LEARNING" ] && LEARNING=$(printf '%s' "$INPUT" | jq -r '.learning // empty')
fi

require_param "agentId (--agent)" "$AGENT_ID"
require_param "agentRole (--role)" "$AGENT_ROLE"
require_param "projectPath (--project)" "$PROJECT_PATH"
require_param "learning (--learning)" "$LEARNING"

# Build body using env vars for safe escaping
export _LRN_AGENT="$AGENT_ID"
export _LRN_ROLE="$AGENT_ROLE"
export _LRN_PROJECT="$PROJECT_PATH"
export _LRN_CONTENT="$LEARNING"

BODY=$(jq -n '{agentId: env._LRN_AGENT, agentRole: env._LRN_ROLE, projectPath: env._LRN_PROJECT, learning: env._LRN_CONTENT}')
unset _LRN_AGENT _LRN_ROLE _LRN_PROJECT _LRN_CONTENT

api_call POST "/memory/record-learning" "$BODY"
