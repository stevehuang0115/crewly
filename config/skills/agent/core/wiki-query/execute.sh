#!/bin/bash
# wiki-query — fetch a vault's system-context payload for LLM synthesis.
#
# Per Atlas v2.1 §3: this skill emits ONLY the system-context (LLM-agnostic).
# The caller's runtime concatenates this with its per-LLM task-instruction
# at prompts/<runtime>.md before making the LLM call. The skill itself
# never curls an LLM endpoint.
#
# Usage:
#   bash execute.sh --vault /path/to/vault --query "what did we decide about pricing"
#   bash execute.sh --vault /path/to/vault --query "..." --top-k 10
#   bash execute.sh --json '{"vaultPath":"/path","query":"...","topK":5}'
#   cat input.json | bash execute.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
VAULT_PATH=""
QUERY=""
TOP_K=""
RECENT_LOG=""

# Detect legacy JSON positional arg
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v)
      VAULT_PATH="$2"
      shift 2
      ;;
    --query|-q)
      QUERY="$2"
      shift 2
      ;;
    --top-k|-k)
      TOP_K="$2"
      shift 2
      ;;
    --recent-log|-r)
      RECENT_LOG="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --vault <vault-dir> --query "<question>" [--top-k 5] [--recent-log 20]
  execute.sh --json '{"vaultPath":"...","query":"...","topK":5,"recentLogEntries":20}'

Outputs JSON system-context for the caller's LLM. Skill makes no LLM calls itself.
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

# Read JSON from stdin if no other input
if [ -z "$INPUT_JSON" ] && [ -z "$QUERY" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    QUERY="$STDIN_DATA"
  fi
fi

# Parse JSON if supplied
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$VAULT_PATH" ] && VAULT_PATH=$(printf '%s' "$INPUT" | jq -r '.vaultPath // empty')
  [ -z "$QUERY" ]      && QUERY=$(printf '%s' "$INPUT" | jq -r '.query // empty')
  [ -z "$TOP_K" ]      && TOP_K=$(printf '%s' "$INPUT" | jq -r '.topK // empty')
  [ -z "$RECENT_LOG" ] && RECENT_LOG=$(printf '%s' "$INPUT" | jq -r '.recentLogEntries // empty')
fi

require_param "vaultPath (--vault)" "$VAULT_PATH"
require_param "query (--query)"     "$QUERY"

# Build body with env-var passthrough so jq escapes safely.
export _WQ_VAULT="$VAULT_PATH"
export _WQ_QUERY="$QUERY"
BODY=$(jq -n '{vaultPath: env._WQ_VAULT, query: env._WQ_QUERY}')
[ -n "$TOP_K" ]      && BODY=$(echo "$BODY" | jq --argjson k "$TOP_K" '. + {topK: $k}')
[ -n "$RECENT_LOG" ] && BODY=$(echo "$BODY" | jq --argjson n "$RECENT_LOG" '. + {recentLogEntries: $n}')
unset _WQ_VAULT _WQ_QUERY

api_call POST "/wiki/query" "$BODY"
