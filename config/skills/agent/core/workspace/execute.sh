#!/bin/bash
# Agent Workspace Skill — read, write, create, and list shared workspaces.
#
# Actions:
#   read   — Read a workspace by ID
#   write  — Write/update workspace data (CAS with expectedVersion)
#   create — Create a new workspace
#   list   — List all available workspaces
#
# Calls the V2 Workspace API at /api/v2/workspaces.
#
# Usage:
#   # CLI flags (preferred)
#   bash execute.sh --action read --id ws-123
#   bash execute.sh --action write --id ws-123 --data '{"key":"val"}' --version 1 --writer agent-1
#   bash execute.sh --action create --name "Sprint results" --owner-type team --owner-id team-1
#   bash execute.sh --action list
#
#   # Legacy JSON (backward compatible)
#   bash execute.sh '{"action":"read","id":"ws-123"}'
#   bash execute.sh '{"action":"write","id":"ws-123","data":{"key":"val"},"expectedVersion":1,"writerId":"agent-1"}'
#   bash execute.sh '{"action":"create","name":"Sprint results","ownerType":"team","ownerId":"team-1"}'
#   bash execute.sh '{"action":"list"}'
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --action <read|write|create|list> [options]

Actions:
  read    Read a workspace
    --id | -i         Workspace ID (required)

  write   Write/update workspace data (CAS)
    --id | -i         Workspace ID (required)
    --data | -d       JSON data object (required)
    --version | -v    Expected version for CAS (required)
    --writer | -w     Writer ID / session name (required)

  create  Create a new workspace
    --name | -n       Workspace name (required)
    --owner-type      Owner type: agent|team|mission|system (required)
    --owner-id        Owner identifier (required)
    --access-mode     Access mode: overwrite|append|structured (default: overwrite)
    --description     Optional description
    --data | -d       Initial data JSON (default: {})
    --allowed-writers Comma-separated list of allowed writer IDs

  list    List all workspaces
    (no options)

General:
  --json | -j         Raw JSON payload
  --help | -h         Show this help
EOF_USAGE
}

INPUT_JSON=""
ACTION=""
WS_ID=""
WS_NAME=""
WS_DESCRIPTION=""
WS_OWNER_TYPE=""
WS_OWNER_ID=""
WS_ACCESS_MODE=""
WS_DATA=""
WS_VERSION=""
WS_WRITER=""
WS_ALLOWED_WRITERS=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --action|-a)
      ACTION="$2"
      shift 2
      ;;
    --id|-i)
      WS_ID="$2"
      shift 2
      ;;
    --name|-n)
      WS_NAME="$2"
      shift 2
      ;;
    --description)
      WS_DESCRIPTION="$2"
      shift 2
      ;;
    --owner-type)
      WS_OWNER_TYPE="$2"
      shift 2
      ;;
    --owner-id)
      WS_OWNER_ID="$2"
      shift 2
      ;;
    --access-mode)
      WS_ACCESS_MODE="$2"
      shift 2
      ;;
    --data|-d)
      WS_DATA="$2"
      shift 2
      ;;
    --version|-v)
      WS_VERSION="$2"
      shift 2
      ;;
    --writer|-w)
      WS_WRITER="$2"
      shift 2
      ;;
    --allowed-writers)
      WS_ALLOWED_WRITERS="$2"
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
if [ -z "$INPUT_JSON" ] && [ -z "$ACTION" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ACTION" ] && ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
  [ -z "$WS_ID" ] && WS_ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
  [ -z "$WS_NAME" ] && WS_NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
  [ -z "$WS_DESCRIPTION" ] && WS_DESCRIPTION=$(printf '%s' "$INPUT" | jq -r '.description // empty')
  [ -z "$WS_OWNER_TYPE" ] && WS_OWNER_TYPE=$(printf '%s' "$INPUT" | jq -r '.ownerType // empty')
  [ -z "$WS_OWNER_ID" ] && WS_OWNER_ID=$(printf '%s' "$INPUT" | jq -r '.ownerId // empty')
  [ -z "$WS_ACCESS_MODE" ] && WS_ACCESS_MODE=$(printf '%s' "$INPUT" | jq -r '.accessMode // empty')
  [ -z "$WS_VERSION" ] && WS_VERSION=$(printf '%s' "$INPUT" | jq -r '.expectedVersion // empty')
  [ -z "$WS_WRITER" ] && WS_WRITER=$(printf '%s' "$INPUT" | jq -r '.writerId // empty')
  [ -z "$WS_ALLOWED_WRITERS" ] && WS_ALLOWED_WRITERS=$(printf '%s' "$INPUT" | jq -r '.allowedWriters // empty')
  # Data is special — extract as raw JSON (not string)
  if [ -z "$WS_DATA" ]; then
    WS_DATA=$(printf '%s' "$INPUT" | jq -c '.data // empty')
    # jq outputs "null" or empty string for missing keys
    [ "$WS_DATA" = "null" ] || [ "$WS_DATA" = '""' ] && WS_DATA=""
  fi
fi

require_param "action (--action)" "$ACTION"

# ---------------------------------------------------------------------------
# Action: list
# ---------------------------------------------------------------------------
if [ "$ACTION" = "list" ]; then
  api_call GET "/v2/workspaces"
  exit 0
fi

# ---------------------------------------------------------------------------
# Action: read
# ---------------------------------------------------------------------------
if [ "$ACTION" = "read" ]; then
  require_param "id (--id)" "$WS_ID"
  api_call GET "/v2/workspaces/${WS_ID}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Action: create
# ---------------------------------------------------------------------------
if [ "$ACTION" = "create" ]; then
  require_param "name (--name)" "$WS_NAME"
  require_param "ownerType (--owner-type)" "$WS_OWNER_TYPE"
  require_param "ownerId (--owner-id)" "$WS_OWNER_ID"

  # Build JSON body safely using jq + env vars
  export _WS_NAME="$WS_NAME"
  export _WS_OWNER_TYPE="$WS_OWNER_TYPE"
  export _WS_OWNER_ID="$WS_OWNER_ID"

  BODY=$(jq -n '{
    name: env._WS_NAME,
    ownerType: env._WS_OWNER_TYPE,
    ownerId: env._WS_OWNER_ID
  }')

  [ -n "$WS_DESCRIPTION" ] && {
    export _WS_DESC="$WS_DESCRIPTION"
    BODY=$(echo "$BODY" | jq --arg d "$_WS_DESC" '. + {description: $d}')
    unset _WS_DESC
  }

  [ -n "$WS_ACCESS_MODE" ] && {
    export _WS_MODE="$WS_ACCESS_MODE"
    BODY=$(echo "$BODY" | jq --arg m "$_WS_MODE" '. + {accessMode: $m}')
    unset _WS_MODE
  }

  if [ -n "$WS_DATA" ]; then
    BODY=$(echo "$BODY" | jq --argjson d "$WS_DATA" '. + {data: $d}')
  fi

  if [ -n "$WS_ALLOWED_WRITERS" ]; then
    # Convert comma-separated string to JSON array
    export _WS_AW="$WS_ALLOWED_WRITERS"
    BODY=$(echo "$BODY" | jq --arg aw "$_WS_AW" '. + {allowedWriters: ($aw | split(",") | map(gsub("^\\s+|\\s+$"; "")))}')
    unset _WS_AW
  fi

  unset _WS_NAME _WS_OWNER_TYPE _WS_OWNER_ID

  api_call POST "/v2/workspaces" "$BODY"
  exit 0
fi

# ---------------------------------------------------------------------------
# Action: write
# ---------------------------------------------------------------------------
if [ "$ACTION" = "write" ]; then
  require_param "id (--id)" "$WS_ID"
  require_param "expectedVersion (--version)" "$WS_VERSION"
  require_param "writerId (--writer)" "$WS_WRITER"
  require_param "data (--data)" "$WS_DATA"

  export _WS_VER="$WS_VERSION"
  export _WS_WRT="$WS_WRITER"

  BODY=$(jq -n --argjson data "$WS_DATA" '{
    expectedVersion: (env._WS_VER | tonumber),
    writerId: env._WS_WRT,
    data: $data
  }')

  unset _WS_VER _WS_WRT

  api_call PUT "/v2/workspaces/${WS_ID}" "$BODY"
  exit 0
fi

# Unknown action
error_exit "Unknown action: $ACTION. Valid actions: read, write, create, list"
