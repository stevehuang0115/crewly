#!/bin/bash
# wiki-queue-add — enqueue wiki-worthy content the agent just saw or said.
#
# Per the 2026-05-22 redesign (Steve): there's NO automatic ingest. Agents
# decide what's worth saving as the conversation unfolds and queue it
# explicitly. A separate `wiki-process-queue` skill (run later, batch or
# bookkeep-triggered) classifies + writes to llm-curated/<folder>/<page>.md.
#
# The `--reason` is REQUIRED — agents must justify why this is wiki-worthy.
#
# Usage:
#   bash execute.sh --vault /path --content "..." --reason "..." --source-ref "..."
#   bash execute.sh --json '{"vaultPath":"...","content":"...","reason":"...","sourceRef":"...","sourceType":"user_chat"}'
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
VAULT_PATH=""
CONTENT=""
REASON=""
SOURCE_REF=""
SOURCE_TYPE="user_chat"
QUEUED_BY=""

# Legacy positional JSON
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v)        VAULT_PATH="$2";  shift 2 ;;
    --content|-c)      CONTENT="$2";     shift 2 ;;
    --reason|-r)       REASON="$2";      shift 2 ;;
    --source-ref)      SOURCE_REF="$2";  shift 2 ;;
    --source-type)     SOURCE_TYPE="$2"; shift 2 ;;
    --queued-by)       QUEUED_BY="$2";   shift 2 ;;
    --json|-j)         INPUT_JSON="$2";  shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --vault <vault> --content "<text>" --reason "<why this matters>" --source-ref "<id|url|path>" [--source-type user_chat|slack_message|spec_file|pr_merge|record_learning|task_verified] [--queued-by <session>]

Required:
  --vault       Absolute path to the vault root.
  --content     The text to capture (the thing future-you wants to remember).
  --reason      WHY this is wiki-worthy. One sentence. Audit + helps the processor.
  --source-ref  Stable reference: chat id, slack thread, file path, WI id.

Optional:
  --source-type Default: user_chat. Use slack_message for Slack inbound; spec_file
                for written specs; pr_merge for commit-driven learnings; etc.
  --queued-by   Session name. Defaults to \$CREWLY_SESSION_NAME or "crewly-orc".

Emit a JSON {success, item} on stdout. The item has status=pending until a
later wiki-process-queue run classifies it.
EOF
      exit 0 ;;
    --) shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift
      else error_exit "Unknown argument: $1"; fi ;;
  esac
done

# stdin JSON fallback
if [ -z "$INPUT_JSON" ] && [ -z "$CONTENT" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then INPUT_JSON="$STDIN_DATA"
  else CONTENT="$STDIN_DATA"; fi
fi

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$VAULT_PATH" ]  && VAULT_PATH=$(printf  '%s' "$INPUT" | jq -r '.vaultPath  // empty')
  [ -z "$CONTENT" ]     && CONTENT=$(printf     '%s' "$INPUT" | jq -r '.content    // empty')
  [ -z "$REASON" ]      && REASON=$(printf      '%s' "$INPUT" | jq -r '.reason     // empty')
  [ -z "$SOURCE_REF" ]  && SOURCE_REF=$(printf  '%s' "$INPUT" | jq -r '.sourceRef  // empty')
  [ "$SOURCE_TYPE" = "user_chat" ] && {
    TY=$(printf '%s' "$INPUT" | jq -r '.sourceType // empty'); [ -n "$TY" ] && SOURCE_TYPE="$TY"
  }
  [ -z "$QUEUED_BY" ]   && QUEUED_BY=$(printf   '%s' "$INPUT" | jq -r '.queuedBy   // empty')
fi

require_param "vaultPath  (--vault)"      "$VAULT_PATH"
require_param "content    (--content)"    "$CONTENT"
require_param "reason     (--reason)"     "$REASON"
require_param "sourceRef  (--source-ref)" "$SOURCE_REF"

# Default queuedBy: session name from env, else "crewly-orc"
if [ -z "$QUEUED_BY" ]; then
  QUEUED_BY="${CREWLY_SESSION_NAME:-crewly-orc}"
fi

export _WQA_VAULT="$VAULT_PATH"
export _WQA_CONTENT="$CONTENT"
export _WQA_REASON="$REASON"
export _WQA_REF="$SOURCE_REF"
export _WQA_TYPE="$SOURCE_TYPE"
export _WQA_BY="$QUEUED_BY"

BODY=$(jq -n '{
  vaultPath:  env._WQA_VAULT,
  queuedBy:   env._WQA_BY,
  sourceType: env._WQA_TYPE,
  sourceRef:  env._WQA_REF,
  content:    env._WQA_CONTENT,
  reason:     env._WQA_REASON
}')

unset _WQA_VAULT _WQA_CONTENT _WQA_REASON _WQA_REF _WQA_TYPE _WQA_BY

api_call POST "/wiki/queue" "$BODY"
