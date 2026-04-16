#!/bin/bash
# Register an agent with the Crewly backend
# Supports both CLI flags (preferred) and legacy JSON argument.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred — avoids shell escaping issues)
  bash execute.sh --session dev-1 --role developer

  # Legacy JSON argument (backward compatible)
  bash execute.sh '{"sessionName":"dev-1","role":"developer"}'

Options:
  --session  | -s   Agent session name (required)
  --role     | -r   Agent role: product-manager, developer, etc. (required)
  --team-member     Team member UUID (optional)
  --claude-session  Claude session ID for resume support (optional)
  --json     | -j   Raw JSON payload (same as legacy)
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
SESSION_NAME=""
ROLE=""
TEAM_MEMBER_ID=""
CLAUDE_SESSION_ID=""

# Detect legacy JSON argument as the first parameter
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session|-s)
      SESSION_NAME="$2"
      shift 2
      ;;
    --role|-r)
      ROLE="$2"
      shift 2
      ;;
    --team-member)
      TEAM_MEMBER_ID="$2"
      shift 2
      ;;
    --claude-session)
      CLAUDE_SESSION_ID="$2"
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
if [ -z "$INPUT_JSON" ] && [ -z "$SESSION_NAME" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON input if provided (backward compatible)
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // .agentId // empty')
  [ -z "$ROLE" ] && ROLE=$(printf '%s' "$INPUT" | jq -r '.role // .agentRole // empty')
  [ -z "$TEAM_MEMBER_ID" ] && TEAM_MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.teamMemberId // empty')
  [ -z "$CLAUDE_SESSION_ID" ] && CLAUDE_SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.claudeSessionId // empty')
fi

require_param "sessionName (--session)" "$SESSION_NAME"
require_param "role (--role)" "$ROLE"

# Build body using env vars for safe escaping
export _REG_ROLE="$ROLE"
export _REG_SESSION="$SESSION_NAME"
export _REG_CLAUDE="$CLAUDE_SESSION_ID"
export _REG_MEMBER="$TEAM_MEMBER_ID"

BODY=$(jq -n \
  --arg role "$_REG_ROLE" \
  --arg sessionName "$_REG_SESSION" \
  --arg claudeSessionId "$_REG_CLAUDE" \
  --arg teamMemberId "$_REG_MEMBER" \
  '{role: $role, sessionName: $sessionName} +
   (if $claudeSessionId != "" then {claudeSessionId: $claudeSessionId} else {} end) +
   (if $teamMemberId != "" then {teamMemberId: $teamMemberId} else {} end)')

unset _REG_ROLE _REG_SESSION _REG_CLAUDE _REG_MEMBER

api_call POST "/teams/members/register" "$BODY"
