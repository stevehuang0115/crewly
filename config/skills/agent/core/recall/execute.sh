#!/bin/bash
# Retrieve stored memories relevant to a given context.
# Supports CLI flags (preferred) and legacy JSON.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
AGENT_ID=""
CONTEXT=""
SCOPE=""
LIMIT=""
PROJECT_PATH=""

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
    --context|-c)
      CONTEXT="$2"
      shift 2
      ;;
    --scope|-s)
      SCOPE="$2"
      shift 2
      ;;
    --limit|-l)
      LIMIT="$2"
      shift 2
      ;;
    --project|-p)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: execute.sh --agent dev-1 --context 'topic to recall' --project /path [--scope project|agent] [--limit 10]"
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

# Read from stdin if no context yet
if [ -z "$INPUT_JSON" ] && [ -z "$CONTEXT" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    CONTEXT="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$AGENT_ID" ] && AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
  [ -z "$CONTEXT" ] && CONTEXT=$(printf '%s' "$INPUT" | jq -r '.context // empty')
  [ -z "$SCOPE" ] && SCOPE=$(printf '%s' "$INPUT" | jq -r '.scope // empty')
  [ -z "$LIMIT" ] && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
fi

require_param "agentId (--agent)" "$AGENT_ID"
require_param "context (--context)" "$CONTEXT"

# Build body using env vars for safe escaping
export _RCL_AGENT="$AGENT_ID"
export _RCL_CTX="$CONTEXT"

BODY=$(jq -n '{agentId: env._RCL_AGENT, context: env._RCL_CTX}')

[ -n "$SCOPE" ] && BODY=$(echo "$BODY" | jq --arg s "$SCOPE" '. + {scope: $s}')
[ -n "$LIMIT" ] && BODY=$(echo "$BODY" | jq --arg l "$LIMIT" '. + {limit: ($l | tonumber)}')
[ -n "$PROJECT_PATH" ] && BODY=$(echo "$BODY" | jq --arg p "$PROJECT_PATH" '. + {projectPath: $p}')

unset _RCL_AGENT _RCL_CTX

api_call POST "/memory/recall" "$BODY"
