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
PAGES=""
INCLUDE_SUPERSEDED=""

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
    --pages|-p)
      PAGES="$2"
      shift 2
      ;;
    --include-superseded)
      INCLUDE_SUPERSEDED="true"
      shift
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
Usage:
  Step 1 — read the index + candidates:
    execute.sh --vault <vault-dir> --query "<question>" [--top-k 5] [--recent-log 20]
  Step 2 — read the 3–5 pages you picked, in full:
    execute.sh --vault <vault-dir> --query "<question>" --pages "llm-curated/decisions/a.md,llm-curated/patterns/b.md"
  execute.sh --json '{"vaultPath":"...","query":"...","pages":["..."],"includeSuperseded":false}'

Outputs JSON system-context (index, candidatePages, pages, recentLog) for the caller's LLM. Superseded pages and
pages your role may not read are hidden; --include-superseded shows the history of a judgement. Every call is
recorded in the vault's usage ledger (a query that finds nothing is logged as a capture gap — say so in your answer).
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
  [ -z "$PAGES" ]      && PAGES=$(printf '%s' "$INPUT" | jq -r '(.pages // []) | join(",")')
  [ -z "$INCLUDE_SUPERSEDED" ] && INCLUDE_SUPERSEDED=$(printf '%s' "$INPUT" | jq -r 'if .includeSuperseded == true then "true" else empty end')
fi

require_param "vaultPath (--vault)" "$VAULT_PATH"
require_param "query (--query)"     "$QUERY"

# Build body with env-var passthrough so jq escapes safely.
export _WQ_VAULT="$VAULT_PATH"
export _WQ_QUERY="$QUERY"
BODY=$(jq -n '{vaultPath: env._WQ_VAULT, query: env._WQ_QUERY}')
[ -n "$TOP_K" ]      && BODY=$(echo "$BODY" | jq --argjson k "$TOP_K" '. + {topK: $k}')
[ -n "$RECENT_LOG" ] && BODY=$(echo "$BODY" | jq --argjson n "$RECENT_LOG" '. + {recentLogEntries: $n}')
[ -n "$PAGES" ] && { export _WQ_PAGES="$PAGES"; BODY=$(echo "$BODY" | jq '. + {pages: (env._WQ_PAGES | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(. != "")))}'); unset _WQ_PAGES; }
[ -n "$INCLUDE_SUPERSEDED" ] && BODY=$(echo "$BODY" | jq '. + {includeSuperseded: true}')
unset _WQ_VAULT _WQ_QUERY

api_call POST "/wiki/query" "$BODY"
