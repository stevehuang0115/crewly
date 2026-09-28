#!/bin/bash
# =============================================================================
# assign-ticket (TL) — assign a project ticket to one of your workers
#
# Backed by POST /api/project-tickets/:project/:id/assign
# (specs/2026-09-28-project-tickets.md §5). The backend checks that you lead a
# team on the project and that the assignee is on an eligible team. An agent
# assignee gets a linked WorkItem right away (dispatched to it); `--no-start`
# only records the assignee.
#
# Usage:
#   bash execute.sh --project P --id APP-12 --to <worker-session> [--no-start]
#   bash execute.sh '{"project":"P","id":"APP-12","to":"worker-session"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --project P --id APP-12 --to <worker-session> [--no-start]

Options:
  --project   Project id, name or absolute path (required)
  --id        Ticket id, e.g. APP-12 (required)
  --to        Session name of the worker (or a person's name) (required)
  --no-start  Only record the assignee; do not create the WorkItem yet
  --help | -h Show this help
EOF_USAGE
}

PROJECT=""; ID=""; TO=""; START="true"
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  PROJECT=$(printf '%s' "$1" | jq -r '.project // .projectPath // .projectId // empty')
  ID=$(printf '%s' "$1" | jq -r '.id // .ticket // empty')
  TO=$(printf '%s' "$1" | jq -r '.to // .assignee // empty')
  START=$(printf '%s' "$1" | jq -r 'if .start == false then "false" else "true" end')
  shift || true
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p) [ $# -ge 2 ] || error_exit "--project requires a value"; PROJECT="$2"; shift 2 ;;
    --id|--ticket) [ $# -ge 2 ] || error_exit "--id requires a value"; ID="$2"; shift 2 ;;
    --to|--assignee) [ $# -ge 2 ] || error_exit "--to requires a value"; TO="$2"; shift 2 ;;
    --no-start) START="false"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

require_param "project" "$PROJECT"
require_param "id" "$ID"
require_param "to" "$TO"

enc() { jq -rn --arg v "$1" '$v|@uri'; }
BODY=$(jq -n --arg to "$TO" --argjson start "$START" '{assignee: $to, start: $start}')
api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/assign" "$BODY" \
  | jq '{success, ticket: (.data.ticket | {id, title, status, priority, assignee, workItemId}), workItemId: (.data.workItem.id // null)}'
