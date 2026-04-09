#!/bin/bash
# Create a V3 Request from a user message determined to be actionable work.
# The orchestrator (with LLM understanding) decides WHEN to call this skill.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --title "Fix auth test" --description "Fix the failing test" \
    --intent-level L1 --intent-category debugging --source-message-id "msg_abc123"

  # Legacy JSON (backward compatible)
  bash execute.sh '{"title":"Fix auth test","description":"Fix failing test","intentLevel":"L1","intentCategory":"debugging"}'

Options:
  --title              | -t   Concise title for the request (required)
  --description        | -d   Full description of the request (required)
  --intent-level             L0, L1, L2, or L3 (required)
  --intent-category          communication, query, code_change, planning, debugging, deployment, team_management, other (required)
  --priority                 low, normal, high, urgent (optional, default: normal)
  --source-message-id        Original message ID for dedup (optional)
  --needs-mission            true/false — trigger Mission creation (optional, default: false)
  --json               | -j  Raw JSON payload (same as legacy)
  --help               | -h  Show this help
EOF_USAGE
}

INPUT_JSON=""
TITLE=""
DESCRIPTION=""
INTENT_LEVEL=""
INTENT_CATEGORY=""
PRIORITY=""
SOURCE_MESSAGE_ID=""
NEEDS_MISSION=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title|-t)
      TITLE="$2"
      shift 2
      ;;
    --description|-d)
      DESCRIPTION="$2"
      shift 2
      ;;
    --intent-level)
      INTENT_LEVEL="$2"
      shift 2
      ;;
    --intent-category)
      INTENT_CATEGORY="$2"
      shift 2
      ;;
    --priority)
      PRIORITY="$2"
      shift 2
      ;;
    --source-message-id)
      SOURCE_MESSAGE_ID="$2"
      shift 2
      ;;
    --needs-mission)
      NEEDS_MISSION="$2"
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

# Read from stdin if no input yet
if [ -z "$INPUT_JSON" ] && [ -z "$TITLE" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TITLE" ] && TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  [ -z "$DESCRIPTION" ] && DESCRIPTION=$(printf '%s' "$INPUT" | jq -r '.description // empty')
  [ -z "$INTENT_LEVEL" ] && INTENT_LEVEL=$(printf '%s' "$INPUT" | jq -r '.intentLevel // empty')
  [ -z "$INTENT_CATEGORY" ] && INTENT_CATEGORY=$(printf '%s' "$INPUT" | jq -r '.intentCategory // empty')
  [ -z "$PRIORITY" ] && PRIORITY=$(printf '%s' "$INPUT" | jq -r '.priority // empty')
  [ -z "$SOURCE_MESSAGE_ID" ] && SOURCE_MESSAGE_ID=$(printf '%s' "$INPUT" | jq -r '.sourceMessageId // empty')
  [ -z "$NEEDS_MISSION" ] && NEEDS_MISSION=$(printf '%s' "$INPUT" | jq -r '.needsMission // empty')
fi

# Validate required parameters
require_param "title (--title)" "$TITLE"
require_param "description (--description)" "$DESCRIPTION"
require_param "intent-level (--intent-level)" "$INTENT_LEVEL"
require_param "intent-category (--intent-category)" "$INTENT_CATEGORY"

# Validate intent-level
case "$INTENT_LEVEL" in
  L0|L1|L2|L3) ;;
  *) error_exit "Invalid --intent-level: $INTENT_LEVEL. Must be L0, L1, L2, or L3." ;;
esac

# Validate intent-category
case "$INTENT_CATEGORY" in
  communication|query|code_change|planning|debugging|deployment|team_management|other) ;;
  *) error_exit "Invalid --intent-category: $INTENT_CATEGORY. Must be one of: communication, query, code_change, planning, debugging, deployment, team_management, other." ;;
esac

# Validate priority if provided
if [ -n "$PRIORITY" ]; then
  case "$PRIORITY" in
    low|normal|high|urgent) ;;
    *) error_exit "Invalid --priority: $PRIORITY. Must be one of: low, normal, high, urgent." ;;
  esac
fi

# Build the request body
BODY=$(jq -n \
  --arg title "$TITLE" \
  --arg description "$DESCRIPTION" \
  --arg intentLevel "$INTENT_LEVEL" \
  --arg intentCategory "$INTENT_CATEGORY" \
  '{title: $title, description: $description, intentLevel: $intentLevel, intentCategory: $intentCategory}')

# Add optional fields
if [ -n "$PRIORITY" ]; then
  BODY=$(printf '%s' "$BODY" | jq --arg p "$PRIORITY" '. + {priority: $p}')
fi

if [ -n "$SOURCE_MESSAGE_ID" ]; then
  BODY=$(printf '%s' "$BODY" | jq --arg sid "$SOURCE_MESSAGE_ID" '. + {sourceConversationItemId: $sid}')
fi

# Call the API to create the Request
RESULT=$(api_call POST "/requests" "$BODY")

# If needs-mission is true, log it in the output for the orchestrator to act on
if [ "$NEEDS_MISSION" = "true" ]; then
  # Extract the request ID from the response and append the needsMission flag
  REQUEST_ID=$(printf '%s' "$RESULT" | jq -r '.data.id // empty')
  if [ -n "$REQUEST_ID" ]; then
    printf '%s' "$RESULT" | jq --arg rid "$REQUEST_ID" '.needsMission = true | .requestId = $rid'
  else
    printf '%s' "$RESULT" | jq '.needsMission = true'
  fi
else
  printf '%s' "$RESULT"
fi
