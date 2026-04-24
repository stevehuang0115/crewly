#!/bin/bash
# Schedule a one-shot (or bounded-recurring) follow-up trigger that fires in
# the future and drops a WorkItem into the pool for you or another agent.
#
# This is the "timer-based follow-up" pattern: you commit to checking back on
# something at time T, and the system wakes you (or the target) when T arrives.
# The trigger is scoped to your team so it shows up under list-my-followups,
# and it auto-cancels after maxFires / maxIdleFires — there is no silent
# forever-loop risk.
#
# Contrast with:
#   - `schedule-check`   — self-timer that just messages you; no team scope.
#   - orchestrator `create-cron` — for recurring org-level schedules.
#
# Supports CLI flags (preferred), legacy JSON, stdin pipe, or @filepath.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # Fire once, 30 minutes from now, target self
  bash execute.sh --in-minutes 30 --title "Check Rex response"

  # Fire once at a specific absolute time (ISO8601), target another agent
  bash execute.sh --fire-at 2026-04-24T09:00:00Z --target crewly-marketing-ella-member-1 --title "Re-prompt Rex"

  # Recurring with a hard cap — 3 tries, 1h apart
  bash execute.sh --cron "0 * * * *" --max-fires 3 --title "Hourly Rex check"

  # Legacy JSON
  bash execute.sh '{"inMinutes":30,"title":"Check Rex","target":"ella"}'

Options:
  --in-minutes | -m   Fire once N minutes from now (mutually exclusive with --fire-at/--cron)
  --fire-at          Fire once at ISO8601 datetime (e.g. 2026-04-24T09:00:00Z)
  --cron             Cron expression for recurring fires (UTC by default)
  --timezone         IANA timezone for cron (default: UTC)
  --target           Agent session to receive the follow-up WorkItem (default: yourself)
  --title     | -T   Title for the generated WorkItem (required)
  --description     Longer description / context
  --name             Stable name (used for cancel / dedup). Auto-generated if absent.
  --max-fires        Stop after N fires (default: 1 for --in-minutes/--fire-at, unlimited for --cron)
  --max-idle-fires   Auto-cancel after N consecutive fires that produced no work (default: 3)
  --json      | -j   Raw JSON payload (same as legacy)
  --help      | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
IN_MINUTES=""
FIRE_AT=""
CRON_EXPR=""
TIMEZONE="UTC"
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
    --in-minutes|-m)      IN_MINUTES="$2"; shift 2 ;;
    --fire-at)            FIRE_AT="$2"; shift 2 ;;
    --cron)               CRON_EXPR="$2"; shift 2 ;;
    --timezone)           TIMEZONE="$2"; shift 2 ;;
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

# Legacy JSON → populate vars
if [ -n "$INPUT_JSON" ]; then
  IN_MINUTES=$(printf '%s' "$INPUT_JSON" | jq -r '.inMinutes // empty')
  FIRE_AT=$(printf '%s' "$INPUT_JSON" | jq -r '.fireAt // empty')
  CRON_EXPR=$(printf '%s' "$INPUT_JSON" | jq -r '.cron // empty')
  TIMEZONE=$(printf '%s' "$INPUT_JSON" | jq -r '.timezone // "UTC"')
  TARGET=$(printf '%s' "$INPUT_JSON" | jq -r '.target // empty')
  TITLE=$(printf '%s' "$INPUT_JSON" | jq -r '.title // empty')
  DESCRIPTION=$(printf '%s' "$INPUT_JSON" | jq -r '.description // empty')
  NAME=$(printf '%s' "$INPUT_JSON" | jq -r '.name // empty')
  MAX_FIRES=$(printf '%s' "$INPUT_JSON" | jq -r '.maxFires // empty')
  MAX_IDLE_FIRES=$(printf '%s' "$INPUT_JSON" | jq -r '.maxIdleFires // "3"')
fi

# Validation
[ -z "$TITLE" ] && { echo '{"error":"--title is required"}' >&2; exit 1; }

TIMING_COUNT=0
[ -n "$IN_MINUTES" ] && TIMING_COUNT=$((TIMING_COUNT + 1))
[ -n "$FIRE_AT" ] && TIMING_COUNT=$((TIMING_COUNT + 1))
[ -n "$CRON_EXPR" ] && TIMING_COUNT=$((TIMING_COUNT + 1))
if [ "$TIMING_COUNT" -ne 1 ]; then
  echo '{"error":"Exactly one of --in-minutes, --fire-at, or --cron must be provided"}' >&2
  exit 1
fi

# Default target = self
[ -z "$TARGET" ] && TARGET="${CREWLY_SESSION_NAME:-}"
[ -z "$TARGET" ] && { echo '{"error":"No --target and CREWLY_SESSION_NAME is unset"}' >&2; exit 1; }

# Resolve owning team (for team-scoped listing / cancel)
TEAM_ID=$(resolve_team_id || true)

# Auto-generate name if caller didn't supply one (stable per target+title)
if [ -z "$NAME" ]; then
  HASH=$(printf '%s|%s' "$TARGET" "$TITLE" | shasum -a 1 | awk '{print substr($1,1,8)}')
  NAME="followup:${HASH}"
fi

# Build TimeTriggerConfig
CONFIG_JSON=""
if [ -n "$IN_MINUTES" ]; then
  DELAY_MS=$((IN_MINUTES * 60 * 1000))
  CONFIG_JSON=$(jq -n --argjson d "$DELAY_MS" '{type:"time", delayMs:$d}')
  # Sensible default for one-shot
  [ -z "$MAX_FIRES" ] && MAX_FIRES="1"
elif [ -n "$FIRE_AT" ]; then
  CONFIG_JSON=$(jq -n --arg f "$FIRE_AT" '{type:"time", fireAt:$f}')
  [ -z "$MAX_FIRES" ] && MAX_FIRES="1"
else
  CONFIG_JSON=$(jq -n --arg c "$CRON_EXPR" --arg tz "$TIMEZONE" '{type:"time", cronExpression:$c, timezone:$tz}')
  # Recurring: no implicit maxFires cap (caller should set one for followup hygiene)
fi

# Build TriggerAction.createWorkItem
WI_JSON=$(jq -n \
  --arg type "delegate" \
  --arg owner "team_lead" \
  --arg target "$TARGET" \
  --arg title "$TITLE" \
  --arg description "$DESCRIPTION" \
  '{type:$type, owner:$owner, target:$target, title:$title}
   + (if $description != "" then {description:$description} else {} end)')

ACTION_JSON=$(jq -n --argjson wi "$WI_JSON" '{createWorkItem: $wi}')

# Assemble final CreateTriggerInput
BODY=$(jq -n \
  --arg type "time" \
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
