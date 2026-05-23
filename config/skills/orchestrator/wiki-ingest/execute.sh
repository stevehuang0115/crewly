#!/bin/bash
# wiki-ingest — append a source into a vault's llm-curated/log.md.
#
# Phase A scope (Atlas v2.1 §4 + §4.5): rules-only routing — the caller
# decides which vault. The chat subscriber already auto-ingests every
# user→ORC message; this skill is for MANUAL ingest (specs, decisions,
# LLM-promoted content, etc.) where you want explicit control.
#
# Refuses writes into frozen paths (memory/, sop-overrides/, sop/,
# team-norm/). Only llm-curated/ is restructure-eligible.
#
# Usage:
#   bash execute.sh --vault /path --source-type spec_file --source-ref /path/to/spec.md --source-body "..."
#   bash execute.sh --vault /path --source-type user_chat --source-ref msg-1 --source-body "..." --caller user/steve
#   bash execute.sh --vault /path --target llm-curated/decisions/2026-05-22-pricing.md --source-type user_chat --source-ref s1 --source-body "..."
#   bash execute.sh --json '{"vaultPath":"...","sourceType":"...","sourceRef":"...","sourceBody":"..."}'
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
VAULT_PATH=""
SOURCE_TYPE=""
SOURCE_REF=""
SOURCE_BODY=""
CALLER=""
TARGET=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v)
      VAULT_PATH="$2"; shift 2 ;;
    --source-type|-t)
      SOURCE_TYPE="$2"; shift 2 ;;
    --source-ref|-r)
      SOURCE_REF="$2"; shift 2 ;;
    --source-body|-b)
      SOURCE_BODY="$2"; shift 2 ;;
    --caller|-c)
      CALLER="$2"; shift 2 ;;
    --target)
      TARGET="$2"; shift 2 ;;
    --json|-j)
      INPUT_JSON="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --vault <vault> --source-type <type> --source-ref <ref> --source-body <body> [--caller <sess>] [--target <relpath>]
  execute.sh --json '{"vaultPath":"...","sourceType":"...","sourceRef":"...","sourceBody":"...","callerSession":"...","targetRelativePath":"..."}'

sourceType MUST be one of:
  user_chat | slack_message | spec_file | pr_merge | record_learning | task_verified

Default target is "llm-curated/log.md". Override with --target for a dedicated page (must NOT be inside a frozen folder).
EOF
      exit 0 ;;
    --)
      shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"; shift
      else
        error_exit "Unknown argument: $1"
      fi ;;
  esac
done

# stdin JSON fallback
if [ -z "$INPUT_JSON" ] && [ -z "$SOURCE_BODY" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    SOURCE_BODY="$STDIN_DATA"
  fi
fi

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$VAULT_PATH" ]  && VAULT_PATH=$(printf  '%s' "$INPUT" | jq -r '.vaultPath          // empty')
  [ -z "$SOURCE_TYPE" ] && SOURCE_TYPE=$(printf '%s' "$INPUT" | jq -r '.sourceType         // empty')
  [ -z "$SOURCE_REF" ]  && SOURCE_REF=$(printf  '%s' "$INPUT" | jq -r '.sourceRef          // empty')
  [ -z "$SOURCE_BODY" ] && SOURCE_BODY=$(printf '%s' "$INPUT" | jq -r '.sourceBody         // empty')
  [ -z "$CALLER" ]      && CALLER=$(printf      '%s' "$INPUT" | jq -r '.callerSession      // empty')
  [ -z "$TARGET" ]      && TARGET=$(printf      '%s' "$INPUT" | jq -r '.targetRelativePath // empty')
fi

require_param "vaultPath  (--vault)"       "$VAULT_PATH"
require_param "sourceType (--source-type)" "$SOURCE_TYPE"
require_param "sourceRef  (--source-ref)"  "$SOURCE_REF"
require_param "sourceBody (--source-body)" "$SOURCE_BODY"

# Build body via env vars (safe escaping).
export _WI_VAULT="$VAULT_PATH"
export _WI_TYPE="$SOURCE_TYPE"
export _WI_REF="$SOURCE_REF"
export _WI_BODY="$SOURCE_BODY"
BODY=$(jq -n '{
  vaultPath:  env._WI_VAULT,
  sourceType: env._WI_TYPE,
  sourceRef:  env._WI_REF,
  sourceBody: env._WI_BODY
}')
[ -n "$CALLER" ] && { export _WI_CALLER="$CALLER"; BODY=$(echo "$BODY" | jq '. + {callerSession: env._WI_CALLER}'); unset _WI_CALLER; }
[ -n "$TARGET" ] && { export _WI_TARGET="$TARGET"; BODY=$(echo "$BODY" | jq '. + {targetRelativePath: env._WI_TARGET}'); unset _WI_TARGET; }
unset _WI_VAULT _WI_TYPE _WI_REF _WI_BODY

api_call POST "/wiki/ingest" "$BODY"
