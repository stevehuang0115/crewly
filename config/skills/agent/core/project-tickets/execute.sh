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
#   bash execute.sh link    --project P --id APP-12 --work-item <WorkItem id>   (owner / orc / lead)
#   bash execute.sh ask-owner --project P --id APP-12 --question "…" --option "A" --option "B — detail"
#                             --default "B"|wait [--deadline ISO] [--sensitive email|publish|deploy|spend]
#                                                                               (owner / orc / lead / assignee)
#   bash execute.sh ask-owner --project P --id APP-12 --clear [--note "answer"]
#   bash execute.sh autopilot --project P [--on|--off] [--driver <session>|--driver default]
#                             [--daily-budget <tokens, e.g. 20M>] [--max-in-flight <n>]      (owner / orchestrator)
#                             [--retro on|off|default]
#   bash execute.sh stats     --project P [--days 14] [--label feed]       (owner / orc / lead)
#   bash execute.sh runs      --project P [--days 7] [--label feed]        (owner / orc / lead)
#   bash execute.sh retro     --project P --day YYYY-MM-DD --summary "…" [--problem "class|title|detail|evidence" …]
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
  bash execute.sh link    --project P --id APP-12 --work-item <id>
                                                              Orchestrator / team lead: tie work already in
                                                              flight (a live WorkItem) to this ticket
  bash execute.sh ask-owner --project P --id APP-12 --question "…" --option "A" --option "B — detail"
                          --default "B"|wait [--deadline ISO] [--sensitive email|publish|deploy|spend]
                                                              Ask the owner ONE question with 2–3 options. The
                                                              ticket's assignee (else its lead) posts it as a card
                                                              in the ticket's Slack thread; the answer comes back
                                                              to that agent as a [DECISION …] message
  bash execute.sh ask-owner --project P --id APP-12 --clear [--note "answer"]
                                                              The owner answered: remove the needs-owner mark
  bash execute.sh autopilot --project P [--on|--off] [--driver <session>|default]
                          [--daily-budget <tokens, e.g. 20M>] [--max-in-flight <n>] [--retro on|off|default]
                                                              Owner / orchestrator: show or change the ticket
                                                              autopilot (no flags = show). --retro: the lead's
                                                              daily retro (default: on while an autopilot
                                                              experiment runs)
  bash execute.sh stats     --project P [--days 14] [--label feed]
                                                              Autopilot numbers per day: tickets triaged /
                                                              started / done / verified / sent back / stalled,
                                                              cycle times, owner touches, stalls by cause,
                                                              interventions, cost vs the daily budget
  bash execute.sh runs      --project P [--days 7] [--label feed]
                                                              Run trace + ticket traces per day (for trace-read)
  bash execute.sh retro     --project P --day YYYY-MM-DD --summary "what shipped, where it stalled, why"
                          [--problem "class|title|detail|evidence" …]
                                                              Team lead: file the daily autopilot retro.
                                                              class = agent_judgment | missing_skill |
                                                              harness_gap | owner_dependency

P = project id, name or absolute path. Workers' new tickets start in backlog;
the owner, the orchestrator or a team lead makes them ready.
EOF_USAGE
}

ACTION=""; PROJECT=""; ID=""; TITLE=""; DESCRIPTION=""; PRIORITY=""; LABELS=""; TEAM=""
STATUS=""; SOURCE=""; REQUEST_ID=""; NOTE=""; OWNER_REVIEW=""; ASSIGNEE=""; START="true"; WORK_ITEM=""
ACCEPTANCE_JSON="null"
HAS_DESCRIPTION=0
QUESTION=""; CLEAR=""; OPTIONS_JSON="[]"; DEFAULT_OPT=""; DEADLINE=""; SENSITIVE=""; AP_ENABLED=""; AP_DRIVER=""; AP_BUDGET=""; AP_MAX=""
AP_RETRO=""; DAYS=""; LABEL=""; DAY=""; SUMMARY=""; PROBLEMS_JSON="[]"

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
  WORK_ITEM=$(printf '%s' "$J" | jq -r '.workItemId // .workItem // empty')
  QUESTION=$(printf '%s' "$J" | jq -r '.question // empty')
  CLEAR=$(printf '%s' "$J" | jq -r 'if .clear == true then "true" else empty end')
  OPTIONS_JSON=$(printf '%s' "$J" | jq -c 'if (.options|type) == "array" then .options else [] end')
  DEFAULT_OPT=$(printf '%s' "$J" | jq -r '.default // empty')
  DEADLINE=$(printf '%s' "$J" | jq -r '.deadline // empty')
  SENSITIVE=$(printf '%s' "$J" | jq -r '.sensitive // empty')
  AP_ENABLED=$(printf '%s' "$J" | jq -r 'if (.enabled|type) == "boolean" then (.enabled|tostring) else empty end')
  AP_DRIVER=$(printf '%s' "$J" | jq -r '.driver // empty')
  AP_BUDGET=$(printf '%s' "$J" | jq -r '.dailyBudgetTokens // empty')
  AP_MAX=$(printf '%s' "$J" | jq -r '.maxInFlightPerMember // empty')
  AP_RETRO=$(printf '%s' "$J" | jq -r 'if (.retro|type) == "boolean" then (if .retro then "on" else "off" end) else (.retro // empty) end')
  DAYS=$(printf '%s' "$J" | jq -r '.days // empty')
  LABEL=$(printf '%s' "$J" | jq -r '.label // empty')
  DAY=$(printf '%s' "$J" | jq -r '.day // empty')
  SUMMARY=$(printf '%s' "$J" | jq -r '.summary // empty')
  PROBLEMS_JSON=$(printf '%s' "$J" | jq -c 'if (.problems|type) == "array" then .problems else [] end')
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
    --work-item|--work-item-id|--workItemId)
                     [ $# -ge 2 ] || error_exit "--work-item requires a value";   WORK_ITEM="$2"; shift 2 ;;
    --question|-q)   [ $# -ge 2 ] || error_exit "--question requires a value";   QUESTION="$2"; shift 2 ;;
    --clear)         CLEAR="true"; shift ;;
    --option|-o)     [ $# -ge 2 ] || error_exit "--option requires a value"
                     OPTIONS_JSON=$(jq -c --arg o "$2" '. + [$o]' <<<"$OPTIONS_JSON"); shift 2 ;;
    --default)       [ $# -ge 2 ] || error_exit "--default requires a value";    DEFAULT_OPT="$2"; shift 2 ;;
    --deadline)      [ $# -ge 2 ] || error_exit "--deadline requires a value";   DEADLINE="$2"; shift 2 ;;
    --sensitive)     [ $# -ge 2 ] || error_exit "--sensitive requires a value";  SENSITIVE="$2"; shift 2 ;;
    --on)            AP_ENABLED="true"; shift ;;
    --off)           AP_ENABLED="false"; shift ;;
    --driver)        [ $# -ge 2 ] || error_exit "--driver requires a value";     AP_DRIVER="$2"; shift 2 ;;
    --daily-budget|--budget)
                     [ $# -ge 2 ] || error_exit "--daily-budget requires a value"; AP_BUDGET="$2"; shift 2 ;;
    --max-in-flight) [ $# -ge 2 ] || error_exit "--max-in-flight requires a value"; AP_MAX="$2"; shift 2 ;;
    --retro)         [ $# -ge 2 ] || error_exit "--retro requires on, off or default"; AP_RETRO="$2"; shift 2 ;;
    --days)          [ $# -ge 2 ] || error_exit "--days requires a value";        DAYS="$2"; shift 2 ;;
    --label)         [ $# -ge 2 ] || error_exit "--label requires a value";       LABEL="$2"; shift 2 ;;
    --day)           [ $# -ge 2 ] || error_exit "--day requires a value";         DAY="$2"; shift 2 ;;
    --summary)       [ $# -ge 2 ] || error_exit "--summary requires a value";     SUMMARY="$2"; shift 2 ;;
    --problem)       [ $# -ge 2 ] || error_exit "--problem requires \"class|title|detail|evidence\""
                     PROBLEMS_JSON=$(jq -c --arg p "$2" '. + [($p | split("|")) as $f | {class: ($f[0] // "" | gsub("^\\s+|\\s+$"; "")), title: ($f[1] // "")} + (if ($f[2] // "") != "" then {detail: $f[2]} else {} end) + (if ($f[3:] | join("|")) != "" then {evidence: ($f[3:] | join("|"))} else {} end)]' <<<"$PROBLEMS_JSON"); shift 2 ;;
    --full)          shift ;;
    --help|-h)       print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

[ -n "$ACTION" ] || { print_usage >&2; error_exit "Missing action: list | show | create | update | claim | release | assign | log | link | ask-owner | autopilot | stats | runs | retro"; }

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
  link)
    require_param "project" "$PROJECT"; require_param "id" "$ID"; require_param "work-item" "$WORK_ITEM"
    BODY=$(jq -n --arg wi "$WORK_ITEM" '{workItemId: $wi}')
    api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/link" "$BODY" \
      | jq "{success, workItemId: .data.workItem.id, ticket: (.data.ticket | ${TICKET_ROW})}"
    ;;
  ask-owner)
    require_param "project" "$PROJECT"; require_param "id" "$ID"
    if [ "$CLEAR" = "true" ]; then
      BODY=$(jq -n --arg note "$NOTE" '{clear: true} + (if $note != "" then {note: $note} else {} end)')
      api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/ask-owner" "$BODY" \
        | jq "{success, withdrawn: .data.withdrawn, ticket: (.data.ticket | ${TICKET_ROW})}"
    else
      require_param "question" "$QUESTION"
      BODY=$(jq -n --arg q "$QUESTION" --argjson o "$OPTIONS_JSON" --arg d "$DEFAULT_OPT" --arg dl "$DEADLINE" --arg s "$SENSITIVE" \
        '{question: $q, options: $o}
         + (if $d != "" then {default: $d} else {} end)
         + (if $dl != "" then {deadline: $dl} else {} end)
         + (if $s != "" then {sensitive: $s} else {} end)')
      api_call POST "/project-tickets/$(enc "$PROJECT")/$(enc "$ID")/ask-owner" "$BODY" \
        | jq "{success, decision: (.data.decision | {id, asker, status, deadline, posted: (.card != null), postError}), ticket: (.data.ticket | if . == null then null else ${TICKET_ROW} end)}"
    fi
    ;;
  autopilot)
    require_param "project" "$PROJECT"
    if [ -z "$AP_ENABLED$AP_DRIVER$AP_BUDGET$AP_MAX$AP_RETRO" ]; then
      api_call GET "/project-ticket-autopilot/$(enc "$PROJECT")" | jq '{success, autopilot: .data}'
    else
      BODY=$(jq -n --arg enabled "$AP_ENABLED" --arg driver "$AP_DRIVER" --arg budget "$AP_BUDGET" --arg max "$AP_MAX" --arg retro "$AP_RETRO" \
        '{}
         + (if $enabled != "" then {enabled: ($enabled == "true")} else {} end)
         + (if $retro == "default" then {retro: null} elif $retro != "" then {retro: $retro} else {} end)
         + (if $driver == "default" then {driver: null} elif $driver != "" then {driver: $driver} else {} end)
         + (if $budget == "default" then {dailyBudgetTokens: null} elif $budget != "" then {dailyBudgetTokens: ($budget | tonumber? // $budget)} else {} end)
         + (if $max == "default" then {maxInFlightPerMember: null} elif $max != "" then {maxInFlightPerMember: ($max | tonumber? // $max)} else {} end)')
      api_call POST "/project-ticket-autopilot/$(enc "$PROJECT")" "$BODY" | jq '{success, autopilot: .data}'
    fi
    ;;
  stats|runs)
    require_param "project" "$PROJECT"
    QS=""
    [ -n "$DAYS" ] && QS="days=$(enc "$DAYS")"
    [ -n "$LABEL" ] && QS="${QS:+$QS&}label=$(enc "$LABEL")"
    if [ "$ACTION" = "stats" ]; then
      api_call GET "/project-ticket-autopilot/$(enc "$PROJECT")/stats${QS:+?$QS}" \
        | jq '{success, stats: (.data | if . == null then null else {project, label, range, pausedForToday, total, labels,
               days: [.days[] | {day, triaged, started, done, verified, sentBack, stalled, ownerTouches: .ownerTouches.total, stallMs: .stalls.totalMs, costUsd, pausedMs, runTraceId}]} end)}'
    else
      api_call GET "/project-ticket-autopilot/$(enc "$PROJECT")/runs${QS:+?$QS}" | jq '{success, runs: .data}'
    fi
    ;;
  retro)
    require_param "project" "$PROJECT"
    require_param "day (--day YYYY-MM-DD)" "$DAY"
    require_param "summary (--summary)" "$SUMMARY"
    BODY=$(jq -n --arg d "$DAY" --arg s "$SUMMARY" --argjson p "$PROBLEMS_JSON" '{day: $d, summary: $s, problems: $p}')
    api_call POST "/project-ticket-autopilot/$(enc "$PROJECT")/retro" "$BODY" | jq '{success, retro: .data, error}'
    ;;
  *)
    error_exit "Unknown action: $ACTION (use list | show | create | update | claim | release | assign | log | link | ask-owner | autopilot | stats | runs | retro)"
    ;;
esac
