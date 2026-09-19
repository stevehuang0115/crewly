#!/bin/bash
# wiki-supersede — a conclusion changed: mark the old page as replaced by the new one.
# The old page is NOT deleted; it drops out of default retrieval and its index line
# carries "⟶ superseded by". Canonical roles (team-leader / orchestrator / owner) only.
#
# Usage:
#   bash execute.sh --vault <vault> --old llm-curated/decisions/old.md --new llm-curated/decisions/new.md --reason "pricing changed 2026-09"
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

VAULT_PATH=""; OLD_PATH=""; NEW_PATH=""; REASON=""; INPUT_JSON=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v) VAULT_PATH="$2"; shift 2 ;;
    --old) OLD_PATH="$2"; shift 2 ;;
    --new) NEW_PATH="$2"; shift 2 ;;
    --reason|-r) REASON="$2"; shift 2 ;;
    --json|-j) INPUT_JSON="$2"; shift 2 ;;
    --help|-h)
      cat <<HELP
Usage: execute.sh --vault <vault> --old <old page> --new <new page> --reason "<why the conclusion changed>"
       execute.sh --json '{"vaultPath":"...","oldPath":"...","newPath":"...","reason":"..."}'
HELP
      exit 0 ;;
    *) error_exit "Unknown argument: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$VAULT_PATH" ] && VAULT_PATH=$(printf '%s' "$INPUT" | jq -r '.vaultPath // empty')
  [ -z "$OLD_PATH" ] && OLD_PATH=$(printf '%s' "$INPUT" | jq -r '.oldPath // empty')
  [ -z "$NEW_PATH" ] && NEW_PATH=$(printf '%s' "$INPUT" | jq -r '.newPath // empty')
  [ -z "$REASON" ] && REASON=$(printf '%s' "$INPUT" | jq -r '.reason // empty')
fi
require_param "vaultPath (--vault)" "$VAULT_PATH"
require_param "oldPath (--old)" "$OLD_PATH"
require_param "newPath (--new)" "$NEW_PATH"
require_param "reason (--reason)" "$REASON"
export _WS_V="$VAULT_PATH" _WS_O="$OLD_PATH" _WS_N="$NEW_PATH" _WS_R="$REASON"
BODY=$(jq -n '{vaultPath: env._WS_V, oldPath: env._WS_O, newPath: env._WS_N, reason: env._WS_R}')
unset _WS_V _WS_O _WS_N _WS_R
api_call POST "/wiki/supersede" "$BODY"
