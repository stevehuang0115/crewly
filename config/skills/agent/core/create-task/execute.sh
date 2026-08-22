#!/bin/bash
# Create a new task as a V3 WorkItem in the task-pool.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# the v1 `POST /task-management/create` endpoint, which wrote a `.md` file
# to the project's `.crewly/tasks/` filesystem. The V3 task-pool's
# `POST /task-pool/add` endpoint is now the sole way to create new tasks.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  # CLI flags (preferred)
  bash execute.sh --project-path /path/to/project --task "Implement login API" \
    --priority high --milestone sprint-1 --session dev-1

  # Legacy JSON (backward compatible)
  bash execute.sh '{"projectPath":"/path/to/project","task":"Implement login API","priority":"high"}'

Options:
  --project-path | -p   Absolute path to the project root (required)
  --task         | -t   Task description (required)
  --priority            Priority level: low, medium, high, critical (default: medium)
  --milestone    | -m   Milestone/sprint name (default: delegated)
  --session      | -s   Session to assign the task to (optional; if omitted, task is open)
  --output-schema       JSON string defining expected output schema (optional)
  --owner               Responsible role: orchestrator, team_lead, agent, system (default: agent)
  --json         | -j   Raw JSON payload (same as legacy)
  --help         | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
PROJECT_PATH=""
TASK=""
PRIORITY=""
MILESTONE=""
SESSION_NAME=""
OUTPUT_SCHEMA=""
OWNER=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-path|-p)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --task|-t)
      TASK="$2"
      shift 2
      ;;
    --priority)
      PRIORITY="$2"
      shift 2
      ;;
    --milestone|-m)
      MILESTONE="$2"
      shift 2
      ;;
    --session|-s)
      SESSION_NAME="$2"
      shift 2
      ;;
    --output-schema)
      OUTPUT_SCHEMA="$2"
      shift 2
      ;;
    --owner)
      OWNER="$2"
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
if [ -z "$INPUT_JSON" ] && [ -z "$TASK" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ -z "$TASK" ] && TASK=$(printf '%s' "$INPUT" | jq -r '.task // empty')
  [ -z "$PRIORITY" ] && PRIORITY=$(printf '%s' "$INPUT" | jq -r '.priority // empty')
  [ -z "$MILESTONE" ] && MILESTONE=$(printf '%s' "$INPUT" | jq -r '.milestone // empty')
  [ -z "$SESSION_NAME" ] && SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
  [ -z "$OUTPUT_SCHEMA" ] && OUTPUT_SCHEMA=$(printf '%s' "$INPUT" | jq -c '.outputSchema // empty')
  [ -z "$OWNER" ] && OWNER=$(printf '%s' "$INPUT" | jq -r '.owner // empty')
fi

# Apply defaults
PRIORITY="${PRIORITY:-medium}"
MILESTONE="${MILESTONE:-delegated}"
OWNER="${OWNER:-agent}"

require_param "projectPath (--project-path)" "$PROJECT_PATH"
require_param "task (--task)" "$TASK"

# Validate `owner` against the WorkItemOwner enum the endpoint accepts.
# This is the field, not the session name — `owner` answers "which role is
# responsible for execution", and `target` answers "which session runs it".
# Sending a session name here fails validation with
# "owner must be one of: orchestrator, team_lead, agent, system".
case "$OWNER" in
  orchestrator|team_lead|agent|system) ;;
  *) error_exit "owner must be one of: orchestrator, team_lead, agent, system (got: '$OWNER'). This is a role, not a session name — use --session/target for the session." ;;
esac

# Build a minimal `CreateWorkItemInput` for `POST /task-pool/add`.
#
# The endpoint reads `req.body` DIRECTLY as the input — there is no
# `{workItem: ...}` envelope. It accepts two shapes: this minimal input
# (server fills id/status/createdAt/retryCount/...), or a legacy full
# WorkItem carrying id AND status AND createdAt. We send the minimal shape,
# matching `team-leader/delegate-task`.
#
# Deliberately NOT sent:
#   - `id`     — this skill has no idempotency key worth preserving, so the
#                server-generated uuid wins. (`CreateWorkItemInput.id` IS
#                honoured when supplied; we simply have nothing stable to
#                supply.)
#   - `status` — derived server-side from dependsOn/scheduledAt.
#   - top-level `priority` — NOT a WorkItem field; it is silently dropped by
#                both body shapes. Priority travels in `metadata.priority`,
#                which is what real pool items carry and what
#                work-item-projection reads.
WORK_ITEM=$(jq -n \
  --arg title "$TASK" \
  --arg target "$SESSION_NAME" \
  --arg owner "$OWNER" \
  --arg projectPath "$PROJECT_PATH" \
  --arg milestone "$MILESTONE" \
  --arg priority "$PRIORITY" \
  '{
    title: $title,
    type: "delegate",
    owner: $owner,
    target: (if $target == "" then null else $target end),
    metadata: { projectPath: $projectPath, milestone: $milestone, priority: $priority }
  } | with_entries(select(.value != null))')

if [ -n "$OUTPUT_SCHEMA" ] && [ "$OUTPUT_SCHEMA" != "" ]; then
  WORK_ITEM=$(printf '%s' "$WORK_ITEM" | jq --argjson schema "$OUTPUT_SCHEMA" '.metadata += {outputSchema: $schema}')
fi

api_call POST "/task-pool/add" "$WORK_ITEM"
