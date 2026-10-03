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
#   bash execute.sh --since 2026-10-01T00:00:00Z [--limit 10]      # recent runs, one line each
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
  bash execute.sh --since ISO [--limit 10]         Runs active since then, one line each, newest first
Options:
  --max-chars N       Size bound of the output (default 4000, 600..16000)
  --stall-minutes N   A gap with no progress longer than this is a stall (default 30)
  --json              Summary text + links + metrics as JSON (metrics are not size-bounded)
EOF_USAGE
}

TRACE=""; WORK_ITEM=""; TICKET=""; REQUEST=""; EXPERIMENT=""; SINCE=""; LIMIT="10"; MAX_CHARS="4000"; STALL=""; JSON_OUT="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trace|-t)       [ $# -ge 2 ] || error_exit "--trace requires a value"; TRACE="$2"; shift 2 ;;
    --work-item|-w)   [ $# -ge 2 ] || error_exit "--work-item requires a value"; WORK_ITEM="$2"; shift 2 ;;
    --ticket)         [ $# -ge 2 ] || error_exit "--ticket requires a value"; TICKET="$2"; shift 2 ;;
    --request|-r)     [ $# -ge 2 ] || error_exit "--request requires a value"; REQUEST="$2"; shift 2 ;;
    --experiment|-e)  [ $# -ge 2 ] || error_exit "--experiment requires a value"; EXPERIMENT="$2"; shift 2 ;;
    --since|-s)       [ $# -ge 2 ] || error_exit "--since requires a value"; SINCE="$2"; shift 2 ;;
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
# The same bounds the backend applies, so the cut below matches its summary.
[ "$MAX_CHARS" -lt 600 ] && MAX_CHARS=600
[ "$MAX_CHARS" -gt 16000 ] && MAX_CHARS=16000

enc() { jq -rn --arg v "$1" '$v|@uri'; }
STALL_QS=""
[ -n "$STALL" ] && STALL_QS="&stallMinutes=$(enc "$STALL")"

# --- Recent runs -------------------------------------------------------------
if [ -z "$TRACE$WORK_ITEM$TICKET$REQUEST$EXPERIMENT" ]; then
  [ -n "$SINCE" ] || { print_usage >&2; error_exit "Pass one of --trace, --work-item, --ticket, --request, --experiment or --since"; }
  if ! RESP=$(api_call_full GET "/traces?since=$(enc "$SINCE")&limit=$(enc "$LIMIT")${STALL_QS}"); then
    error_exit "Could not list traces since $SINCE"
  fi
  if [ "$JSON_OUT" = "1" ]; then
    printf '%s' "$RESP" | jq -c '{success: true, traces: [.data.traces[] | {traceId, kind: .root.kind, summary: .root.summary, updatedAt, metrics}]}'
    exit 0
  fi
  printf '%s' "$RESP" | jq -r --argjson max "$MAX_CHARS" '
    def dur: (. / 60000 | floor) as $m
      | if $m < 1 then "<1m" elif $m < 60 then "\($m)m" elif $m < 1440 then "\($m / 60 | floor)h \($m % 60)m" else "\($m / 1440 | floor)d \(($m % 1440) / 60 | floor)h" end;
    (.data.traces // []) as $t
    | (if ($t | length) == 0 then "No traces active since then."
       else ([ "\($t | length) runs (newest first):" ] + [ $t[] |
         "\(.traceId) · \(.root.kind) · \(.updatedAt[0:16] | sub("T"; " ")) · \(.root.summary[0:80])" +
         (if .metrics then
            " — \(.metrics.state | gsub("_"; " ")); wall \(.metrics.wallMs | dur), active \(.metrics.activeMs | dur), waiting on owner \(.metrics.waitingOwnerMs | dur); touches \(.metrics.ownerTouches), rework \(.metrics.rework), stalls \(.metrics.stalls)\(if .metrics.ongoingStall then " (one ongoing)" else "" end), interventions \(.metrics.interventions), $\(.metrics.costUsd * 100 | round / 100)"
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

if ! RESP=$(api_call_full GET "/traces/$(enc "$TRACE")/summary?maxChars=${MAX_CHARS}${STALL_QS}"); then
  error_exit "Trace $TRACE could not be read"
fi
if [ "$JSON_OUT" = "1" ]; then
  printf '%s' "$RESP" | jq -c --argjson max "$MAX_CHARS" '{success: true, traceId: .data.traceId, links: .data.links, text: (.data.text[0:$max]), metrics: .data.metrics}'
else
  # The backend already keeps the text within --max-chars; cut again so a
  # different backend version can never flood the caller's context.
  printf '%s' "$RESP" | jq -r --argjson max "$MAX_CHARS" '.data.text as $t | if ($t | length) > $max then $t[0:($max - 1)] + "…" else $t end'
fi
