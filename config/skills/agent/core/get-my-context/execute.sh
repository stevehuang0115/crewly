#!/bin/bash
# Retrieve accumulated context including memories, learnings, and project knowledge
# Supports both CLI flags (preferred) and legacy JSON argument.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred — avoids shell escaping issues)
  bash execute.sh --agent dev-1 --role developer --project /path/to/project

  # Legacy JSON argument (backward compatible)
  bash execute.sh '{"agentId":"dev-1","agentRole":"developer","projectPath":"/path"}'

Options:
  --agent    | -a   Agent session name/ID (required)
  --role     | -r   Agent role: product-manager, developer, etc. (required)
  --project  | -p   Project root path (required)
  --json     | -j   Raw JSON payload (same as legacy)
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
AGENT_ID=""
AGENT_ROLE=""
PROJECT_PATH=""

# Detect legacy JSON argument as the first parameter
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
    --role|-r)
      AGENT_ROLE="$2"
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

# If nothing provided yet but stdin has data, read it as JSON
if [ -z "$INPUT_JSON" ] && [ -z "$AGENT_ID" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON input if provided (backward compatible)
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$AGENT_ID" ] && AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
  [ -z "$AGENT_ROLE" ] && AGENT_ROLE=$(printf '%s' "$INPUT" | jq -r '.agentRole // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
fi

require_param "agentId (--agent)" "$AGENT_ID"
require_param "agentRole (--role)" "$AGENT_ROLE"
require_param "projectPath (--project)" "$PROJECT_PATH"

BODY=$(jq -n \
  --arg agentId "$AGENT_ID" \
  --arg agentRole "$AGENT_ROLE" \
  --arg projectPath "$PROJECT_PATH" \
  '{agentId: $agentId, agentRole: $agentRole, projectPath: $projectPath}')

api_call POST "/memory/my-context" "$BODY"
