#!/bin/bash
# Mark a stale memory entry as superseded by a newer one.
# Memory Phase 1 — M4. Hides the old entry from default recall while keeping
# it in the audit log. Both entries must already exist in the agent memory store.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --agent dev-1 --old-id rk-old --new-id rk-new --reason "Pricing updated 2026-05-01"

  # Legacy JSON (backward compatible)
  bash execute.sh '{"agentId":"dev-1","oldId":"rk-old","newId":"rk-new","reason":"Pricing updated"}'

Options:
  --agent   | -a   Agent ID / session name (required)
  --old-id  | -o   Id of the entry being superseded (required)
  --new-id  | -n   Id of the new entry that replaces the old one (required)
  --reason  | -r   Optional human-readable reason; appended to old entry's evidence
  --json    | -j   Raw JSON payload
  --help    | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
AGENT_ID=""
OLD_ID=""
NEW_ID=""
REASON=""

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
    --old-id|-o)
      OLD_ID="$2"
      shift 2
      ;;
    --new-id|-n)
      NEW_ID="$2"
      shift 2
      ;;
    --reason|-r)
      REASON="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
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
        error_exit "Unknown argument: $1. Use --help for usage."
      fi
      ;;
  esac
done

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$AGENT_ID" ] && AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
  [ -z "$OLD_ID" ] && OLD_ID=$(printf '%s' "$INPUT" | jq -r '.oldId // empty')
  [ -z "$NEW_ID" ] && NEW_ID=$(printf '%s' "$INPUT" | jq -r '.newId // empty')
  [ -z "$REASON" ] && REASON=$(printf '%s' "$INPUT" | jq -r '.reason // empty')
fi

require_param "agentId (--agent)" "$AGENT_ID"
require_param "oldId (--old-id)" "$OLD_ID"
require_param "newId (--new-id)" "$NEW_ID"

# Build body using env vars to safely handle special characters in reason.
export _SUP_AGENT="$AGENT_ID"
export _SUP_OLD="$OLD_ID"
export _SUP_NEW="$NEW_ID"

if [ -n "$REASON" ]; then
  export _SUP_REASON="$REASON"
  BODY=$(jq -n '{agentId: env._SUP_AGENT, oldId: env._SUP_OLD, newId: env._SUP_NEW, reason: env._SUP_REASON}')
  unset _SUP_REASON
else
  BODY=$(jq -n '{agentId: env._SUP_AGENT, oldId: env._SUP_OLD, newId: env._SUP_NEW}')
fi
unset _SUP_AGENT _SUP_OLD _SUP_NEW

api_call POST "/memory/supersede" "$BODY"
