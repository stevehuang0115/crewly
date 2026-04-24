#!/bin/bash
# Subscribe to an EventBus event (e.g. `agent:idle`, `task:completed`) and
# create a WorkItem for you or another agent when it fires.
#
# This is the "event-based follow-up" pattern: you commit to reacting to a
# specific signal, rather than polling on a timer. Most common use is "when
# Rex stops working, check whether the task is done and if not, re-prompt".
#
# Known event types (see types/event-bus.types.ts for the authoritative list):
#   agent:idle        — an agent entered idle state
#   agent:active      — an agent started working
#   agent:inactive    — an agent was marked inactive (stopped heartbeating)
#   task:completed    — a task was marked done
#   task:failed       — a task failed
#
# Supports CLI flags (preferred), legacy JSON, stdin pipe, or @filepath.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # Watch Rex for idle and route a follow-up WorkItem back to yourself
  bash execute.sh --event-type agent:idle \
    --filter-session crewly-marketing-rex-member-1 \
    --title "Rex went idle — check task status"

  # Watch for any task:completed event, fire-and-done after 1 hit
  bash execute.sh --event-type task:completed --max-fires 1 --title "Task done — ack"

Options:
  --event-type      Event type to watch (required). Examples: agent:idle, task:completed, task:failed.
  --filter-session  Only fire when the event's sessionName matches this value
  --filter-json     Raw JSON filter object (advanced; merged with --filter-session)
  --target          Session that should receive the generated WorkItem (default: yourself)
  --title     | -T  Title for the generated WorkItem (required)
  --description     Longer description / context
  --name            Stable name for cancel/dedup. Auto-generated if absent.
  --max-fires       Stop after N fires (default: unlimited — use --max-idle-fires as safety)
  --max-idle-fires  Auto-cancel after N consecutive unproductive fires (default: 3)
  --json      | -j  Raw JSON payload (legacy)
  --help      | -h  Show this help
EOF_USAGE
}

INPUT_JSON=""
EVENT_TYPE=""
FILTER_SESSION=""
FILTER_JSON=""
TARGET=""
TITLE=""
DESCRIPTION=""
NAME=""
MAX_FIRES=""
MAX_IDLE_FIRES="3"

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --event-type)         EVENT_TYPE="$2"; shift 2 ;;
    --filter-session)     FILTER_SESSION="$2"; shift 2 ;;
    --filter-json)        FILTER_JSON="$2"; shift 2 ;;
    --target)             TARGET="$2"; shift 2 ;;
    --title|-T)           TITLE="$2"; shift 2 ;;
    --description)        DESCRIPTION="$2"; shift 2 ;;
    --name)               NAME="$2"; shift 2 ;;
    --max-fires)          MAX_FIRES="$2"; shift 2 ;;
    --max-idle-fires)     MAX_IDLE_FIRES="$2"; shift 2 ;;
    --json|-j)            INPUT_JSON="$2"; shift 2 ;;
    --help|-h)            print_usage; exit 0 ;;
    --)                   shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"; shift
      else
        echo '{"error":"Unknown argument: '"$1"'"}' >&2
        exit 1
      fi
      ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  EVENT_TYPE=$(printf '%s' "$INPUT_JSON" | jq -r '.eventType // empty')
  FILTER_SESSION=$(printf '%s' "$INPUT_JSON" | jq -r '.filterSession // empty')
  FILTER_JSON=$(printf '%s' "$INPUT_JSON" | jq -rc '.filter // empty')
  TARGET=$(printf '%s' "$INPUT_JSON" | jq -r '.target // empty')
  TITLE=$(printf '%s' "$INPUT_JSON" | jq -r '.title // empty')
  DESCRIPTION=$(printf '%s' "$INPUT_JSON" | jq -r '.description // empty')
  NAME=$(printf '%s' "$INPUT_JSON" | jq -r '.name // empty')
  MAX_FIRES=$(printf '%s' "$INPUT_JSON" | jq -r '.maxFires // empty')
  MAX_IDLE_FIRES=$(printf '%s' "$INPUT_JSON" | jq -r '.maxIdleFires // "3"')
fi

[ -z "$EVENT_TYPE" ] && { echo '{"error":"--event-type is required"}' >&2; exit 1; }
[ -z "$TITLE" ] && { echo '{"error":"--title is required"}' >&2; exit 1; }

[ -z "$TARGET" ] && TARGET="${CREWLY_SESSION_NAME:-}"
[ -z "$TARGET" ] && { echo '{"error":"No --target and CREWLY_SESSION_NAME is unset"}' >&2; exit 1; }

TEAM_ID=$(resolve_team_id || true)

if [ -z "$NAME" ]; then
  HASH=$(printf '%s|%s|%s' "$EVENT_TYPE" "$TARGET" "$TITLE" | shasum -a 1 | awk '{print substr($1,1,8)}')
  NAME="watch:${HASH}"
fi

# Build the filter object. --filter-session is sugar for {sessionName: "..."}.
FILTER_OBJ=""
if [ -n "$FILTER_JSON" ]; then
  FILTER_OBJ="$FILTER_JSON"
fi
if [ -n "$FILTER_SESSION" ]; then
  if [ -n "$FILTER_OBJ" ]; then
    FILTER_OBJ=$(printf '%s' "$FILTER_OBJ" | jq --arg s "$FILTER_SESSION" '. + {sessionName:$s}')
  else
    FILTER_OBJ=$(jq -n --arg s "$FILTER_SESSION" '{sessionName:$s}')
  fi
fi

if [ -n "$FILTER_OBJ" ]; then
  CONFIG_JSON=$(jq -n --arg et "$EVENT_TYPE" --argjson f "$FILTER_OBJ" '{type:"signal", eventType:$et, filter:$f}')
else
  CONFIG_JSON=$(jq -n --arg et "$EVENT_TYPE" '{type:"signal", eventType:$et}')
fi

WI_JSON=$(jq -n \
  --arg type "delegate" \
  --arg owner "team_lead" \
  --arg target "$TARGET" \
  --arg title "$TITLE" \
  --arg description "$DESCRIPTION" \
  '{type:$type, owner:$owner, target:$target, title:$title}
   + (if $description != "" then {description:$description} else {} end)')

ACTION_JSON=$(jq -n --argjson wi "$WI_JSON" '{createWorkItem: $wi}')

BODY=$(jq -n \
  --arg type "signal" \
  --argjson config "$CONFIG_JSON" \
  --argjson action "$ACTION_JSON" \
  --arg createdBy "system" \
  --arg name "$NAME" \
  --arg teamId "$TEAM_ID" \
  --arg maxFires "$MAX_FIRES" \
  --arg maxIdle "$MAX_IDLE_FIRES" \
  '{type:$type, config:$config, action:$action, createdBy:$createdBy, name:$name}
   + (if $teamId != "" then {teamId:$teamId} else {} end)
   + (if $maxFires != "" then {maxFires:($maxFires|tonumber)} else {} end)
   + (if $maxIdle != "" then {maxIdleFires:($maxIdle|tonumber)} else {} end)')

RESP=$(api_call POST "/triggers" "$BODY")
echo "$RESP"
