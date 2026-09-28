#!/bin/bash
# =============================================================================
# project-tickets — a project's own backlog (<project>/.crewly/tickets/)
#
# Backed by /api/project-tickets (specs/2026-09-28-project-tickets.md §6).
#
# Usage:
#   bash execute.sh list    [--project P] [--status ready]
#   bash execute.sh show    --project P --id APP-12
#   bash execute.sh create  --project P --title "…" [--description "…"] [--acceptance "…" …]
#                           [--priority P1] [--labels a,b] [--team <teamId>] [--status ready]
#                           [--source request:TKT-012] [--request-id <id>] [--owner-review]
#   bash execute.sh update  --project P --id APP-12 [--title …] [--priority …] [--labels …]
#                           [--description …] [--acceptance "…" …] [--status …] [--note "…"]
#   bash execute.sh claim   --project P --id APP-12
#   bash execute.sh release --project P --id APP-12 [--note "why"]
#   bash execute.sh assign  --project P --id APP-12 --to <session> [--no-start]   (owner / orc / lead)
#   bash execute.sh log     --project P --id APP-12 --note "progress"
#   bash execute.sh '{"action":"create","project":"P","title":"…"}'
#
# P = project id, name, or absolute path.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh list    [--project P] [--status ready]      Tickets of a project (or of all your teams' projects)
  bash execute.sh show    --project P --id APP-12             One ticket with its full body
  bash execute.sh create  --project P --title "…" [--description "…"] [--acceptance "…" …]
                          [--priority P0-P3] [--labels a,b] [--team <teamId>] [--status backlog|ready]
                          [--source request:TKT-012] [--request-id <id>] [--owner-review]
  bash execute.sh update  --project P --id APP-12 [--title …] [--priority …] [--labels …]
                          [--description …] [--acceptance "…" …] [--status …] [--note "…"]
  bash execute.sh claim   --project P --id APP-12             Take a ready ticket (creates your WorkItem)
  bash execute.sh release --project P --id APP-12 [--note …]  Give your ticket back (→ ready)
  bash execute.sh assign  --project P --id APP-12 --to <session> [--no-start]
                                                              Orchestrator / team lead: put someone on it
  bash execute.sh log     --project P --id APP-12 --note "…"  Add a progress note to the ticket's Log

P = project id, name or absolute path. Workers' new tickets start in backlog;
the owner, the orchestrator or a team lead makes them ready.
EOF_USAGE
}

ACTION=""; PROJECT=""; ID=""; TITLE=""; DESCRIPTION=""; PRIORITY=""; LABELS=""; TEAM=""
STATUS=""; SOURCE=""; REQUEST_ID=""; NOTE=""; OWNER_REVIEW=""; ASSIGNEE=""; START="true"
ACCEPTANCE_JSON="null"
HAS_DESCRIPTION=0

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  J="$1"; shift
  ACTION=$(printf '%s' "$J" | jq -r '.action // empty')
  PROJECT=$(printf '%s' "$J" | jq -r '.project // .projectPath // .projectId // empty')
  ID=$(printf '%s' "$J" | jq -r '.id // .ticket // empty')
  TITLE=$(printf '%s' "$J" | jq -r '.title // empty')
  if printf '%s' "$J" | jq -e 'has("description")' >/dev/null; then
    DESCRIPTION=$(printf '%s' "$J" | jq -r '.description // ""'); HAS_DESCRIPTION=1
  fi
  PRIORITY=$(printf '%s' "$J" | jq -r '.priority // empty')
  LABELS=$(printf '%s' "$J" | jq -r 'if (.labels|type) == "array" then (.labels|join(",")) else (.labels // empty) end')
  TEAM=$(printf '%s' "$J" | jq -r '.team // empty')
  STATUS=$(printf '%s' "$J" | jq -r '.status // empty')
  SOURCE=$(printf '%s' "$J" | jq -r '.source // empty')
  REQUEST_ID=$(printf '%s' "$J" | jq -r '.requestId // empty')
  NOTE=$(printf '%s' "$J" | jq -r '.note // empty')
  OWNER_REVIEW=$(printf '%s' "$J" | jq -r 'if .ownerReview == true then "true" else empty end')
  ACCEPTANCE_JSON=$(printf '%s' "$J" | jq -c 'if (.acceptance|type) == "array" then .acceptance else null end')
  ASSIGNEE=$(printf '%s' "$J" | jq -r '.to // .assignee // empty')
  START=$(printf '%s' "$J" | jq -r 'if .start == false then "false" else "true" end')
fi
if [[ -z "$ACTION" && $# -gt 0 && ${1:0:1} != '-' ]]; then ACTION="$1"; shift; fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p)    [ $# -ge 2 ] || error_exit "--project requires a value";     PROJECT="$2"; shift 2 ;;
    --id|--ticket)   [ $# -ge 2 ] || error_exit "--id requires a value";          ID="$2"; shift 2 ;;
    --title)         [ $# -ge 2 ] || error_exit "--title requires a value";       TITLE="$2"; shift 2 ;;
    --description)   [ $# -ge 2 ] || error_exit "--description requires a value"; DESCRIPTION="$2"; HAS_DESCRIPTION=1; shift 2 ;;
    --acceptance)    [ $# -ge 2 ] || error_exit "--acceptance requires a value"
                     ACCEPTANCE_JSON=$(jq -c --arg a "$2" 'if . == null then [$a] else . + [$a] end' <<<"$ACCEPTANCE_JSON"); shift 2 ;;
    --priority)      [ $# -ge 2 ] || error_exit "--priority requires a value";    PRIORITY="$2"; shift 2 ;;
    --labels)        [ $# -ge 2 ] || error_exit "--labels requires a value";      LABELS="$2"; shift 2 ;;
    --team)          [ $# -ge 2 ] || error_exit "--team requires a value";        TEAM="$2"; shift 2 ;;
    --status)        [ $# -ge 2 ] || error_exit "--status requires a value";      STATUS="$2"; shift 2 ;;
    --source)        [ $# -ge 2 ] || error_exit "--source requires a value";      SOURCE="$2"; shift 2 ;;
    --request-id)    [ $# -ge 2 ] || error_exit "--request-id requires a value";  REQUEST_ID="$2"; shift 2 ;;
    --note)          [ $# -ge 2 ] || error_exit "--note requires a value";        NOTE="$2"; shift 2 ;;
    --owner-review)  OWNER_REVIEW="true"; shift ;;
    --to|--assignee) [ $# -ge 2 ] || error_exit "--to requires a value";         ASSIGNEE="$2"; shift 2 ;;
    --no-start)      START="false"; shift ;;
    --full)          shift ;;
    --help|-h)       print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

[ -n "$ACTION" ] || { print_usage >&2; error_exit "Missing action: list | show | create | update | claim | release | assign | log"; }

# URL-encode a path segment (project paths contain slashes).
enc() { jq -rn --arg v "$1" '$v|@uri'; }

# Compact one-line-per-ticket view for lists.
TICKET_ROW='{id, title, status, priority, assignee, labels, workItemId}'

case "$ACTION" in
  list)
    if [ -n "$PROJECT" ]; then
      QS=""; [ -n "$STATUS" ] && QS="?status=$(enc "$STATUS")"
      api_call GET "/project-tickets/$(enc "$PROJECT")${QS}" | jq "{success, project: .data.project, tickets: [.data.tickets[] | ${TICKET_ROW}], invalid: .data.invalid}"
    else
      QS=""; [ -n "$STATUS" ] && QS="?status=$(enc "$STATUS")"
      api_call GET "/project-tickets${QS}" | jq "{success, projects: [.data[] | {project, tickets: [.tickets[] | ${TICKET_ROW}]}]}"
    fi
    ;;
  show)
    require_param "project" "$PROJECT"; require_param "id" "$ID"
    api_call GET "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")" | jq '{success, ticket: (.data | del(.extra))}'
    ;;
  create)
    require_param "project" "$PROJECT"; require_param "title" "$TITLE"
    BODY=$(jq -n --arg title "$TITLE" --arg description "$DESCRIPTION" --argjson hasDescription "$HAS_DESCRIPTION" \
      --arg priority "$PRIORITY" --arg labels "$LABELS" --arg team "$TEAM" --arg status "$STATUS" \
      --arg source "$SOURCE" --arg requestId "$REQUEST_ID" --arg ownerReview "$OWNER_REVIEW" --argjson acceptance "$ACCEPTANCE_JSON" \
      '{title: $title}
       + (if $hasDescription == 1 then {description: $description} else {} end)
       + (if $acceptance != null then {acceptance: $acceptance} else {} end)
       + (if $priority != "" then {priority: $priority} else {} end)
       + (if $labels != "" then {labels: ($labels | split(",") | map(gsub("^\\s+|\\s+$"; "")))} else {} end)
       + (if $team != "" then {team: $team} else {} end)
       + (if $status != "" then {status: $status} else {} end)
       + (if $source != "" then {source: $source} else {} end)
       + (if $requestId != "" then {requestId: $requestId} else {} end)
       + (if $ownerReview == "true" then {ownerReview: true} else {} end)')
    api_call POST "/project-tickets/$(enc "$PROJECT")" "$BODY" | jq "{success, ticket: (.data | ${TICKET_ROW} + {fileName})}"
    ;;
  update)
    require_param "project" "$PROJECT"; require_param "id" "$ID"
    BODY=$(jq -n --arg title "$TITLE" --arg description "$DESCRIPTION" --argjson hasDescription "$HAS_DESCRIPTION" \
      --arg priority "$PRIORITY" --arg labels "$LABELS" --arg team "$TEAM" --arg status "$STATUS" \
      --arg note "$NOTE" --arg ownerReview "$OWNER_REVIEW" --argjson acceptance "$ACCEPTANCE_JSON" \
      '{}
       + (if $title != "" then {title: $title} else {} end)
       + (if $hasDescription == 1 then {description: $description} else {} end)
       + (if $acceptance != null then {acceptance: $acceptance} else {} end)
       + (if $priority != "" then {priority: $priority} else {} end)
       + (if $labels != "" then {labels: ($labels | split(",") | map(gsub("^\\s+|\\s+$"; "")))} else {} end)
       + (if $team != "" then {team: $team} else {} end)
       + (if $status != "" then {status: $status} else {} end)
       + (if $note != "" then {note: $note} else {} end)
       + (if $ownerReview == "true" then {ownerReview: true} else {} end)')
    [ "$BODY" != "{}" ] || error_exit "Nothing to update"
    api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/update" "$BODY" | jq "{success, ticket: (.data | ${TICKET_ROW})}"
    ;;
  claim)
    require_param "project" "$PROJECT"; require_param "id" "$ID"
    api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/claim" '{}' \
      | jq "{success, claimed: .data.claimed, workItemId: .data.workItem.id, ticket: (.data.ticket | ${TICKET_ROW}),
             next: \"Do the work; when done, complete this WorkItem (complete-task / report-status with workItemId). The ticket closes when it is verified.\"}"
    ;;
  release)
    require_param "project" "$PROJECT"; require_param "id" "$ID"
    BODY=$(jq -n --arg note "$NOTE" '{status: "ready"} + (if $note != "" then {note: $note} else {} end)')
    api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/transition" "$BODY" | jq "{success, ticket: (.data | ${TICKET_ROW})}"
    ;;
  assign)
    require_param "project" "$PROJECT"; require_param "id" "$ID"; require_param "to" "$ASSIGNEE"
    BODY=$(jq -n --arg to "$ASSIGNEE" --argjson start "$START" '{assignee: $to, start: $start}')
    api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/assign" "$BODY" \
      | jq "{success, workItemId: (.data.workItem.id // null), ticket: (.data.ticket | ${TICKET_ROW})}"
    ;;
  log)
    require_param "project" "$PROJECT"; require_param "id" "$ID"; require_param "note" "$NOTE"
    BODY=$(jq -n --arg note "$NOTE" '{note: $note}')
    api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/log" "$BODY" | jq '{success, lastLog: (.data.log | last)}'
    ;;
  *)
    error_exit "Unknown action: $ACTION (use list | show | create | update | claim | release | assign | log)"
    ;;
esac
