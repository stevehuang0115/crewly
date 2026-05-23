#!/bin/bash
# wiki-bookkeep — vault health report + consolidation signals.
#
# Use this skill periodically (or when the queue stats / md-count
# threshold says "fire"). The skill returns a JSON report:
#   - total / recent md counts
#   - per-folder bucket counts
#   - likely-duplicate clusters (filename Jaccard)
#   - stale-page count (90+ days untouched)
#   - queue snapshot (pending/claimed/processed/skipped)
#   - recommendations
#
# This skill does NOT write to the vault. After reading the report,
# YOUR runtime decides which clusters to merge (call wiki-ingest with
# a consolidated body) and which pages to archive (out of Phase 1
# scope — flag in chat for now).
#
# Usage:
#   bash execute.sh --vault /path
#   bash execute.sh --vault /path --window-days 14 --threshold 10
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
VAULT_PATH=""
WINDOW=""
THRESHOLD=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"; shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v)        VAULT_PATH="$2"; shift 2 ;;
    --window-days|-d)  WINDOW="$2";     shift 2 ;;
    --threshold|-t)    THRESHOLD="$2";  shift 2 ;;
    --json|-j)         INPUT_JSON="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --vault <path> [--window-days 7] [--threshold 10]

Returns a JSON bookkeeping report with should-fire signal, recent activity,
duplicate clusters, queue snapshot, and recommendations. The skill makes
no LLM calls; you decide next actions based on the report.
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
  [ -z "$VAULT_PATH" ] && VAULT_PATH=$(printf '%s' "$INPUT" | jq -r '.vaultPath   // empty')
  [ -z "$WINDOW" ]     && WINDOW=$(printf     '%s' "$INPUT" | jq -r '.windowDays  // empty')
  [ -z "$THRESHOLD" ]  && THRESHOLD=$(printf  '%s' "$INPUT" | jq -r '.threshold   // empty')
fi

require_param "vaultPath (--vault)" "$VAULT_PATH"

export _WB_V="$VAULT_PATH"
BODY=$(jq -n '{vaultPath: env._WB_V}')
[ -n "$WINDOW" ]    && BODY=$(echo "$BODY" | jq --argjson w "$WINDOW"    '. + {windowDays: $w}')
[ -n "$THRESHOLD" ] && BODY=$(echo "$BODY" | jq --argjson t "$THRESHOLD" '. + {threshold: $t}')
unset _WB_V

api_call POST "/wiki/bookkeep" "$BODY"
