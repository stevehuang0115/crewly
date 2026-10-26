#!/bin/bash
# =============================================================================
# trace-read — how a run went, sized for your context: time (active / waiting
# on the owner / waiting on an agent / idle), owner touches, rework, stalls
# with their cause, harness interventions, tokens and cost, key events, links.
#
# Backed by GET /api/traces (specs/2026-10-03-autonomy-metrics.md, issue #984).
#
# Usage:
#   bash execute.sh --trace tr-20261003-ab12cd34
#   bash execute.sh --work-item <id> | --ticket CE-7 | --ticket TKT-12 | --request <id> | --experiment EXP-3
#   bash execute.sh --since 2026-10-01T00:00:00Z [--until ISO] [--limit 10]   # recent runs, one line each
#       [--project <id|name|path>] [--day YYYY-MM-DD] [--label <ticket label>]   # narrow the list (#1472)
#   bash execute.sh --where TKT-12 | --where <request id>             # who holds it NOW, doing what, since when
#   Options: [--max-chars 4000] [--stall-minutes 30] [--json]
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --trace tr-YYYYMMDD-xxxxxxxx     One run: metrics, stalls with causes, key events, links
  bash execute.sh --work-item ID                   The run a work item belongs to
  bash execute.sh --ticket CE-7 | --ticket TKT-12  The run of a project ticket or an owner ticket
  bash execute.sh --request ID                     The run of a Request
  bash execute.sh --experiment EXP-3               The run of an experiment card
  bash execute.sh --since ISO [--until ISO] [--limit 10]
                                                   Runs active in that window, one line each, newest first (at most 100)
      [--project ID|NAME|PATH]                     Only runs of that autopilot project (members and supervisors)
      [--day YYYY-MM-DD] [--label LABEL]           Only runs tagged with that autopilot day / ticket label
  bash execute.sh --where TKT-12 | --where ID      Where an owner request is NOW: who holds it, doing what, for how long
Options:
  --max-chars N       Size bound of the output (default 4000, 600..64000; one run's summary is at most 16000)
  --stall-minutes N   A gap with no progress longer than this is a stall (default 30)
  --json              Summary text + links + metrics as JSON (metrics are not size-bounded)
A week is more than 100 runs for a busy project: page it with --since / --until a day at a time.
EOF_USAGE
}

WHERE=""; TRACE=""; WORK_ITEM=""; TICKET=""; REQUEST=""; EXPERIMENT=""; SINCE=""; UNTIL=""; PROJECT=""; DAY=""; LABEL=""; LIMIT="10"; MAX_CHARS="4000"; STALL=""; JSON_OUT="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --where)          [ $# -ge 2 ] || error_exit "--where requires a request id or TKT-n"; WHERE="$2"; shift 2 ;;
    --trace|-t)       [ $# -ge 2 ] || error_exit "--trace requires a value"; TRACE="$2"; shift 2 ;;
    --work-item|-w)   [ $# -ge 2 ] || error_exit "--work-item requires a value"; WORK_ITEM="$2"; shift 2 ;;
    --ticket)         [ $# -ge 2 ] || error_exit "--ticket requires a value"; TICKET="$2"; shift 2 ;;
    --request|-r)     [ $# -ge 2 ] || error_exit "--request requires a value"; REQUEST="$2"; shift 2 ;;
    --experiment|-e)  [ $# -ge 2 ] || error_exit "--experiment requires a value"; EXPERIMENT="$2"; shift 2 ;;
    --since|-s)       [ $# -ge 2 ] || error_exit "--since requires a value"; SINCE="$2"; shift 2 ;;
    --until|-u)       [ $# -ge 2 ] || error_exit "--until requires a value"; UNTIL="$2"; shift 2 ;;
    --project|-p)     [ $# -ge 2 ] || error_exit "--project requires an id, name or path"; PROJECT="$2"; shift 2 ;;
    --day)            [ $# -ge 2 ] || error_exit "--day requires YYYY-MM-DD"; DAY="$2"; shift 2 ;;
    --label)          [ $# -ge 2 ] || error_exit "--label requires a value"; LABEL="$2"; shift 2 ;;
    --limit|-l)       [ $# -ge 2 ] || error_exit "--limit requires a value"; LIMIT="$2"; shift 2 ;;
    --max-chars)      [ $# -ge 2 ] || error_exit "--max-chars requires a value"; MAX_CHARS="$2"; shift 2 ;;
    --stall-minutes)  [ $# -ge 2 ] || error_exit "--stall-minutes requires a value"; STALL="$2"; shift 2 ;;
    --json)           JSON_OUT="1"; shift ;;
    --help|-h)        print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1 (see --help)" ;;
  esac
done

[[ "$MAX_CHARS" =~ ^[0-9]+$ ]] || error_exit "--max-chars must be a whole number"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || error_exit "--limit must be a whole number"
[ -z "$STALL" ] || [[ "$STALL" =~ ^[0-9]+(\.[0-9]+)?$ ]] || error_exit "--stall-minutes must be a positive number"
[ -z "$DAY" ] || [[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || error_exit "--day must be a date YYYY-MM-DD"
# A list of a week's runs may need more than one run's summary (#1472); the
# backend still bounds one run's summary text at 16000 (SUMMARY_MAX below).
[ "$MAX_CHARS" -lt 600 ] && MAX_CHARS=600
[ "$MAX_CHARS" -gt 64000 ] && MAX_CHARS=64000
SUMMARY_MAX="$MAX_CHARS"
[ "$SUMMARY_MAX" -gt 16000 ] && SUMMARY_MAX=16000
# The backend embeds metrics in at most 100 rows; ask for no more.
[ "$LIMIT" -gt 100 ] && LIMIT=100
[ "$LIMIT" -lt 1 ] && LIMIT=1

enc() { jq -rn --arg v "$1" '$v|@uri'; }
STALL_QS=""
[ -n "$STALL" ] && STALL_QS="&stallMinutes=$(enc "$STALL")"

# --- Where a request is now (backed by GET /api/requests/:id/whereabouts) ---
if [ -n "$WHERE" ]; then
  if ! RESP=$(api_call_full GET "/requests/$(enc "$WHERE")/whereabouts"); then
    error_exit "No owner request $WHERE (pass a request id or TKT-n)"
  fi
  if [ "$JSON_OUT" = "1" ]; then
    printf '%s' "$RESP" | jq -c '{success: true} + .data'
    exit 0
  fi
  printf '%s' "$RESP" | jq -r --argjson max "$MAX_CHARS" '
    def dur: (. / 60000 | floor) as $m
      | if $m < 60 then "\($m)m" elif $m < 2880 then "\($m / 60 | floor)h \($m % 60)m" else "\($m / 1440 | floor)d \(($m % 1440) / 60 | floor)h" end;
    .data as $d
    | ([ "\(if $d.ticketNumber then "TKT-\($d.ticketNumber) · " else "" end)\($d.title[0:100]) · \($d.status)", $d.summary ]
       + [ $d.holders[] | "- \(.session): \(.state | gsub("_"; " ")) for \(.forMs | dur) (since \(.since[0:16] | sub("T"; " ")))\(if .workItemId then " · \(.workItemId)" else "" end)\(if .from then " · from \(.from)" else "" end)\(if .blockedReason then " · blocked: \(.blockedReason[0:120])" else "" end)\(if .what then " · \(.what[0:100])" else "" end)" ]
       | join("\n")) as $text
    | if ($text | length) > $max then $text[0:($max - 1)] + "…" else $text end'
  exit 0
fi

# --- Recent runs -------------------------------------------------------------
if [ -z "$TRACE$WORK_ITEM$TICKET$REQUEST$EXPERIMENT" ]; then
  [ -n "$SINCE" ] || { print_usage >&2; error_exit "Pass one of --where, --trace, --work-item, --ticket, --request, --experiment or --since"; }
  QS="since=$(enc "$SINCE")"
  [ -n "$UNTIL" ] && QS="${QS}&until=$(enc "$UNTIL")"
  QS="${QS}&limit=$(enc "$LIMIT")"
  if [ -n "$PROJECT" ]; then
    # Accept the project's id, name or path; the API wants the id.
    PROJECT_ID="$PROJECT"
    if PROJECTS=$(api_call GET "/projects" 2>/dev/null); then
      FOUND=$(printf '%s' "$PROJECTS" | jq -r --arg p "$PROJECT" '[.data[]? | select(.id == $p or .name == $p or .path == $p) | .id] | first // empty')
      [ -n "$FOUND" ] && PROJECT_ID="$FOUND"
    fi
    QS="${QS}&autopilotProject=$(enc "$PROJECT_ID")"
  fi
  [ -n "$DAY" ] && QS="${QS}&day=$(enc "$DAY")"
  [ -n "$LABEL" ] && QS="${QS}&label=$(enc "$LABEL")"
  if ! RESP=$(api_call_full GET "/traces?${QS}${STALL_QS}"); then
    error_exit "Could not list traces since $SINCE${UNTIL:+ until $UNTIL}${PROJECT:+ for project $PROJECT}"
  fi
  if [ "$JSON_OUT" = "1" ]; then
    # project / day / labels come from the autopilot tags; metrics carry
    # stallMsByCause so a reader can split idle time by cause (#1472).
    printf '%s' "$RESP" | jq -c '{success: true, traces: [.data.traces[] | {traceId, kind: .root.kind, summary: .root.summary, updatedAt, project: .tags.autopilot.projectId, day: .tags.autopilot.day, labels: .tags.labels, metrics}]}'
    exit 0
  fi
  printf '%s' "$RESP" | jq -r --argjson max "$MAX_CHARS" '
    def dur: (. / 60000 | floor) as $m
      | if $m < 1 then "<1m" elif $m < 60 then "\($m)m" elif $m < 1440 then "\($m / 60 | floor)h \($m % 60)m" else "\($m / 1440 | floor)d \(($m % 1440) / 60 | floor)h" end;
    # Stall time by who was stuck: the harness (quota, delivery), the owner, or the team (waiting on an agent, nobody pushing).
    def stallSplit: .stallMsByCause as $c
      | if ($c | not) or (.stallMs // 0) == 0 then ""
        else " (harness \((($c.runtime_quota // 0) + ($c.delivery_failure // 0)) | dur), owner \(($c.waiting_on_owner // 0) | dur), team \((($c.waiting_on_agent // 0) + ($c.nobody_pushing // 0)) | dur))" end;
    (.data.traces // []) as $t
    | (if ($t | length) == 0 then "No traces active in that window."
       else ([ "\($t | length) runs (newest first):" ] + [ $t[] |
         "\(.traceId) · \(.root.kind) · \(.updatedAt[0:16] | sub("T"; " ")) · \(.root.summary[0:80])" +
         (if .metrics then
            " — \(.metrics.state | gsub("_"; " ")); wall \(.metrics.wallMs | dur), active \(.metrics.activeMs | dur), waiting on owner \(.metrics.waitingOwnerMs | dur); touches \(.metrics.ownerTouches), rework \(.metrics.rework), stalls \(.metrics.stalls)\(if .metrics.ongoingStall then " (one ongoing)" else "" end)\(.metrics | stallSplit), interventions \(.metrics.interventions), $\(.metrics.costUsd * 100 | round / 100)"
          else "" end) ] | join("\n")) + "\nRead one: trace-read --trace <id>"
       end) as $text
    | if ($text | length) > $max then $text[0:($max - 1)] + "…" else $text end'
  exit 0
fi

# --- One run -----------------------------------------------------------------
if [ -z "$TRACE" ]; then
  if [ -n "$WORK_ITEM" ]; then Q="workItemId=$(enc "$WORK_ITEM")"
  elif [ -n "$TICKET" ]; then Q="ticketId=$(enc "$TICKET")"
  elif [ -n "$REQUEST" ]; then Q="requestId=$(enc "$REQUEST")"
  else Q="experimentId=$(enc "$EXPERIMENT")"; fi
  if ! REF=$(api_call GET "/traces/by-ref?${Q}" 2>/dev/null); then
    error_exit "No trace for that reference (only work started after run traces were enabled has one)"
  fi
  TRACE=$(printf '%s' "$REF" | jq -r '.data.traceId // empty')
  [ -n "$TRACE" ] || error_exit "No trace for that reference"
fi
[[ "$TRACE" =~ ^tr-[0-9]{8}-[0-9a-f]+$ ]] || error_exit "Not a trace id (tr-YYYYMMDD-xxxxxxxx): $TRACE"

if ! RESP=$(api_call_full GET "/traces/$(enc "$TRACE")/summary?maxChars=${SUMMARY_MAX}${STALL_QS}"); then
  error_exit "Trace $TRACE could not be read"
fi
if [ "$JSON_OUT" = "1" ]; then
  printf '%s' "$RESP" | jq -c --argjson max "$SUMMARY_MAX" '{success: true, traceId: .data.traceId, links: .data.links, text: (.data.text[0:$max]), metrics: .data.metrics}'
else
  # The backend already keeps the text within the bound; cut again so a
  # different backend version can never flood the caller's context.
  printf '%s' "$RESP" | jq -r --argjson max "$SUMMARY_MAX" '.data.text as $t | if ($t | length) > $max then $t[0:($max - 1)] + "…" else $t end'
fi
