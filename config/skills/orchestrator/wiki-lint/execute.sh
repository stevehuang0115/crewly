#!/bin/bash
# wiki-lint — deterministic vault validation pass.
#
# Distinct from wiki-bookkeep (which reports HEALTH metrics). Lint focuses
# on CORRECTNESS:
#   - frozenPathRespected (no ingest-style writes inside frozen folders)
#   - missingEntities      ([[wikilinks]] that resolve to no page)
#   - orphanPages          (pages with zero incoming wikilinks)
#   - staleClaims          (untouched for staleDays, default 90)
#   - restructureProposals (heuristics for llm-curated/ only)
#
# This skill does NOT modify the vault. Your runtime reads the report and
# decides next actions: rename / merge / archive (via wiki-ingest for the
# rewrites; archiving is out of Phase 1 scope — surface in chat).
#
# Usage:
#   bash execute.sh --vault /path
#   bash execute.sh --vault /path --stale-days 60
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
VAULT_PATH=""
STALE_DAYS=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"; shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v)       VAULT_PATH="$2";  shift 2 ;;
    --stale-days|-s)  STALE_DAYS="$2";  shift 2 ;;
    --json|-j)        INPUT_JSON="$2";  shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --vault <path> [--stale-days 90]

Runs a deterministic validation pass and returns a JSON report. Each
section is capped to 50 rows so the payload stays bounded. The skill
makes no LLM calls; your runtime decides what to act on.
EOF
      exit 0 ;;
    --) shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift
      else error_exit "Unknown argument: $1"; fi ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$VAULT_PATH" ] && VAULT_PATH=$(printf '%s' "$INPUT" | jq -r '.vaultPath  // empty')
  [ -z "$STALE_DAYS" ] && STALE_DAYS=$(printf '%s' "$INPUT" | jq -r '.staleDays  // empty')
fi

require_param "vaultPath (--vault)" "$VAULT_PATH"

export _WL_V="$VAULT_PATH"
BODY=$(jq -n '{vaultPath: env._WL_V}')
[ -n "$STALE_DAYS" ] && BODY=$(echo "$BODY" | jq --argjson s "$STALE_DAYS" '. + {staleDays: $s}')
unset _WL_V

api_call POST "/wiki/lint" "$BODY"
