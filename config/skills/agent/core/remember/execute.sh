#!/bin/bash
# Store a memory entry for future recall.
# Supports CLI flags (preferred) and legacy JSON.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --agent dev-1 --content "Important finding" --category pattern --scope project --project /path

  # Content from stdin
  echo "Multi-line finding" | bash execute.sh --agent dev-1 --category pattern --scope project --project /path

  # Content from file
  bash execute.sh --agent dev-1 --content-file /tmp/finding.txt --category pattern --scope project

  # Legacy JSON (backward compatible)
  bash execute.sh '{"agentId":"dev-1","content":"...","category":"pattern","scope":"project"}'

Options:
  --agent    | -a   Agent ID / session name (required)
  --content  | -c   Memory content text (required unless piped via stdin)
  --content-file    Read content from file path
  --category | -C   Category: pattern, decision, gotcha, fact, preference (required)
  --scope    | -s   Scope: project or agent (required)
  --project  | -p   Project path (required for project scope)
  --json     | -j   Raw JSON payload
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
AGENT_ID=""
CONTENT=""
CATEGORY=""
SCOPE=""
PROJECT_PATH=""

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
    --content|-c)
      CONTENT="$2"
      shift 2
      ;;
    --content-file)
      CONTENT="$(cat "$2")"
      shift 2
      ;;
    --category|-C)
      CATEGORY="$2"
      shift 2
      ;;
    --scope|-s)
      SCOPE="$2"
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

# Read from stdin if no content yet
if [ -z "$INPUT_JSON" ] && [ -z "$CONTENT" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    CONTENT="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$AGENT_ID" ] && AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
  [ -z "$CONTENT" ] && CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
  [ -z "$CATEGORY" ] && CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // empty')
  [ -z "$SCOPE" ] && SCOPE=$(printf '%s' "$INPUT" | jq -r '.scope // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
fi

require_param "agentId (--agent)" "$AGENT_ID"
require_param "content (--content)" "$CONTENT"
require_param "category (--category)" "$CATEGORY"
require_param "scope (--scope)" "$SCOPE"

# #187: Auto-inject projectPath from CREWLY_PROJECT_PATH env var when not provided
if [ -z "$PROJECT_PATH" ] && [ -n "${CREWLY_PROJECT_PATH:-}" ]; then
  PROJECT_PATH="$CREWLY_PROJECT_PATH"
fi

# Build body using env vars to safely handle special characters
export _MEM_AGENT="$AGENT_ID"
export _MEM_CONTENT="$CONTENT"
export _MEM_CATEGORY="$CATEGORY"
export _MEM_SCOPE="$SCOPE"

if [ -n "$PROJECT_PATH" ]; then
  export _MEM_PROJECT="$PROJECT_PATH"
  BODY=$(jq -n '{agentId: env._MEM_AGENT, content: env._MEM_CONTENT, category: env._MEM_CATEGORY, scope: env._MEM_SCOPE, projectPath: env._MEM_PROJECT}')
  unset _MEM_PROJECT
else
  BODY=$(jq -n '{agentId: env._MEM_AGENT, content: env._MEM_CONTENT, category: env._MEM_CATEGORY, scope: env._MEM_SCOPE}')
fi
unset _MEM_AGENT _MEM_CONTENT _MEM_CATEGORY _MEM_SCOPE

api_call POST "/memory/remember" "$BODY"
