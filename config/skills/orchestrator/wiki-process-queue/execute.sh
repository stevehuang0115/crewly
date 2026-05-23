#!/bin/bash
# wiki-process-queue — claim the next pending wiki item + return the
# system-context your runtime should classify it against.
#
# This skill does NOT call an LLM. It returns the queue item + the
# vault's current state (SCHEMA, frozen paths, recent log, candidate
# pages by keyword overlap). Your runtime concatenates with the per-LLM
# task-instruction prompt at prompts/<runtime>.md and synthesizes a
# target path. After the LLM picks a target you (the agent) MUST:
#
#   1. POST /api/wiki/ingest with { vaultPath, targetRelativePath, ... }
#   2. POST /api/wiki/queue/<id>/process with { ingested, pagesWritten,
#      targetPath, summary }
#   …OR…
#   3. POST /api/wiki/queue/<id>/skip with { skipReason } if you decided
#      the item isn't actually wiki-worthy after seeing the vault context.
#
# Usage:
#   bash execute.sh --claimed-by <session>
#   bash execute.sh --claimed-by <session> --vault /path --top-k 5
#   bash execute.sh --json '{"claimedBy":"crewly-orc","vaultPath":"/path"}'
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
CLAIMED_BY=""
VAULT_PATH=""
OFFSET=""
TOP_K=""
RECENT_LOG=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claimed-by|-b) CLAIMED_BY="$2"; shift 2 ;;
    --vault|-v)      VAULT_PATH="$2"; shift 2 ;;
    --offset|-o)     OFFSET="$2";     shift 2 ;;
    --top-k|-k)      TOP_K="$2";      shift 2 ;;
    --recent-log|-r) RECENT_LOG="$2"; shift 2 ;;
    --json|-j)       INPUT_JSON="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --claimed-by <session> [--vault <path>] [--offset N] [--top-k 5] [--recent-log 10]
  execute.sh --json '{"claimedBy":"crewly-orc","vaultPath":"...","offset":0}'

Claims the next pending queue item AND returns the vault context for
your runtime's LLM to classify. After the LLM picks a target, call:
  - /api/wiki/ingest         (write the page)
  - /api/wiki/queue/<id>/process  (mark this item processed)
…or:
  - /api/wiki/queue/<id>/skip     (mark not-wiki-worthy after all)
EOF
      exit 0 ;;
    --) shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift
      else error_exit "Unknown argument: $1"; fi ;;
  esac
done

if [ -z "$INPUT_JSON" ] && [ -z "$CLAIMED_BY" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then INPUT_JSON="$STDIN_DATA"; fi
fi

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$CLAIMED_BY" ] && CLAIMED_BY=$(printf '%s' "$INPUT" | jq -r '.claimedBy        // empty')
  [ -z "$VAULT_PATH" ] && VAULT_PATH=$(printf '%s' "$INPUT" | jq -r '.vaultPath        // empty')
  [ -z "$OFFSET" ]     && OFFSET=$(printf     '%s' "$INPUT" | jq -r '.offset           // empty')
  [ -z "$TOP_K" ]      && TOP_K=$(printf      '%s' "$INPUT" | jq -r '.topK             // empty')
  [ -z "$RECENT_LOG" ] && RECENT_LOG=$(printf '%s' "$INPUT" | jq -r '.recentLogEntries // empty')
fi

if [ -z "$CLAIMED_BY" ]; then
  CLAIMED_BY="${CREWLY_SESSION_NAME:-crewly-orc}"
fi

export _WPQ_BY="$CLAIMED_BY"
BODY=$(jq -n '{claimedBy: env._WPQ_BY}')
[ -n "$VAULT_PATH" ] && { export _WPQ_V="$VAULT_PATH"; BODY=$(echo "$BODY" | jq '. + {vaultPath: env._WPQ_V}'); unset _WPQ_V; }
[ -n "$OFFSET" ]     && BODY=$(echo "$BODY" | jq --argjson o "$OFFSET" '. + {offset: $o}')
[ -n "$TOP_K" ]      && BODY=$(echo "$BODY" | jq --argjson k "$TOP_K"  '. + {topK: $k}')
[ -n "$RECENT_LOG" ] && BODY=$(echo "$BODY" | jq --argjson n "$RECENT_LOG" '. + {recentLogEntries: $n}')
unset _WPQ_BY

api_call POST "/wiki/queue/claim-next" "$BODY"
