#!/bin/bash
# Create a new Mission via the mission API.
# Allows TLs and agents to define high-level objectives with success criteria.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --objective "Ship V3 architecture" --owner-team-id team-123 \
    --success-criteria '["All services migrated","Tests passing"]' \
    --strategy "Incremental migration with feature flags"

  # Legacy JSON (backward compatible)
  bash execute.sh '{"objective":"Ship V3","ownerTeamId":"team-123","successCriteria":["Done"],"currentStrategy":"Incremental"}'

Options:
  --objective       | -o   Mission objective (required)
  --owner-team-id   | -t   Team ID that owns this mission (required)
  --success-criteria| -c   JSON array of success criteria strings (required)
  --strategy        | -s   Current strategy description (required)
  --cadence               Cadence string, e.g. "daily", "weekly" (optional)
  --policy                JSON object for mission policy overrides (optional)
  --json            | -j   Raw JSON payload (same as legacy)
  --help            | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
OBJECTIVE=""
OWNER_TEAM_ID=""
SUCCESS_CRITERIA=""
STRATEGY=""
CADENCE=""
POLICY=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --objective|-o)
      OBJECTIVE="$2"
      shift 2
      ;;
    --owner-team-id|-t)
      OWNER_TEAM_ID="$2"
      shift 2
      ;;
    --success-criteria|-c)
      SUCCESS_CRITERIA="$2"
      shift 2
      ;;
    --strategy|-s)
      STRATEGY="$2"
      shift 2
      ;;
    --cadence)
      CADENCE="$2"
      shift 2
      ;;
    --policy)
      POLICY="$2"
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
if [ -z "$INPUT_JSON" ] && [ -z "$OBJECTIVE" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$OBJECTIVE" ] && OBJECTIVE=$(printf '%s' "$INPUT" | jq -r '.objective // empty')
  [ -z "$OWNER_TEAM_ID" ] && OWNER_TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.ownerTeamId // empty')
  [ -z "$SUCCESS_CRITERIA" ] && SUCCESS_CRITERIA=$(printf '%s' "$INPUT" | jq -c '.successCriteria // empty')
  [ -z "$STRATEGY" ] && STRATEGY=$(printf '%s' "$INPUT" | jq -r '.currentStrategy // .strategy // empty')
  [ -z "$CADENCE" ] && CADENCE=$(printf '%s' "$INPUT" | jq -r '.cadence // empty')
  [ -z "$POLICY" ] && POLICY=$(printf '%s' "$INPUT" | jq -c '.policy // empty')
fi

require_param "objective (--objective)" "$OBJECTIVE"
require_param "ownerTeamId (--owner-team-id)" "$OWNER_TEAM_ID"
require_param "successCriteria (--success-criteria)" "$SUCCESS_CRITERIA"
require_param "currentStrategy (--strategy)" "$STRATEGY"

# Validate successCriteria is a JSON array
if ! printf '%s' "$SUCCESS_CRITERIA" | jq -e 'type == "array"' >/dev/null 2>&1; then
  error_exit "successCriteria must be a JSON array of strings, e.g. '[\"criterion 1\",\"criterion 2\"]'"
fi

# Build the request body
BODY=$(jq -n \
  --arg objective "$OBJECTIVE" \
  --arg ownerTeamId "$OWNER_TEAM_ID" \
  --argjson successCriteria "$SUCCESS_CRITERIA" \
  --arg currentStrategy "$STRATEGY" \
  '{objective: $objective, ownerTeamId: $ownerTeamId, successCriteria: $successCriteria, currentStrategy: $currentStrategy}')

# Attach optional cadence
if [ -n "$CADENCE" ] && [ "$CADENCE" != "" ]; then
  BODY=$(printf '%s' "$BODY" | jq --arg cadence "$CADENCE" '. + {cadence: $cadence}')
fi

# Attach optional policy
if [ -n "$POLICY" ] && [ "$POLICY" != "" ]; then
  BODY=$(printf '%s' "$BODY" | jq --argjson policy "$POLICY" '. + {policy: $policy}')
fi

api_call POST "/missions" "$BODY"
