#!/bin/bash
# =============================================================================
# experiment-card — attach an experiment to an optimisation ticket; Crewly
# captures the baseline when it ships and measures it when the window ends.
#
# Backed by /api/experiments (specs/experiment-cards.md, issue #986).
#
# Usage:
#   bash execute.sh create --hypothesis "…" --source gsc|ga4 --measure M --config /abs/seo-ops.config.json
#                          [--page P] [--page-match exact|contains] [--query Q] [--query-match exact|contains]
#                          [--event NAME] [--channel all] [--label "…"] [--title "…"]
#                          [--from A] [--to B] [--direction increase|decrease] [--window-days 14]
#                          [--confidence 0.6] [--project P --ticket ID | --tkt TKT-12]
#   bash execute.sh ship    --id EXP-3 [--shipped-at ISO]
#   bash execute.sh show    --id EXP-3
#   bash execute.sh list    [--status planned|running|done|cancelled] [--ticket ID]
#   bash execute.sh measure --id EXP-3
#   bash execute.sh cancel  --id EXP-3 [--reason "…"]
#   bash execute.sh '{"action":"create","hypothesis":"…","metric":{…},"ticket":{…}}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh create --hypothesis "change X → metric Y from a to b" --source gsc|ga4 --measure M
                         --config /abs/path/seo-ops.config.json [filters] [--from A] [--to B]
                         [--window-days 14] [--confidence 0.6] [--project P --ticket ID | --tkt TKT-12]
      gsc measures: clicks impressions ctr position   (filters: --page URL --query Q, --page-match/--query-match exact|contains)
      ga4 measures: sessions events                   (filters: --page /path, --event NAME, --channel all)
  bash execute.sh ship    --id EXP-3 [--shipped-at ISO]   The change is live (automatic when the ticket is done)
  bash execute.sh show    --id EXP-3                      Card, baseline, result and timeline
  bash execute.sh list    [--status S] [--ticket ID]
  bash execute.sh measure --id EXP-3                      Measure now (only once it is due)
  bash execute.sh cancel  --id EXP-3 [--reason "…"]
EOF_USAGE
}

ACTION=""; ID=""; JSON_BODY=""
HYPOTHESIS=""; TITLE=""; SOURCE=""; MEASURE=""; CONFIG=""; PAGE=""; PAGE_MATCH=""; QUERY=""; QUERY_MATCH=""
EVENT=""; CHANNEL=""; LABEL=""; FROM=""; TO=""; DIRECTION=""; WINDOW=""; CONFIDENCE=""; PROJECT=""; TICKET=""; TKT=""
SHIPPED_AT=""; STATUS=""; REASON=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  J=$(read_json_input "$1"); shift
  ACTION=$(printf '%s' "$J" | jq -r '.action // empty')
  ID=$(printf '%s' "$J" | jq -r '.id // empty')
  SHIPPED_AT=$(printf '%s' "$J" | jq -r '.shippedAt // empty')
  STATUS=$(printf '%s' "$J" | jq -r '.status // empty')
  REASON=$(printf '%s' "$J" | jq -r '.reason // empty')
  TICKET=$(printf '%s' "$J" | jq -r 'if (.ticket|type) == "string" then .ticket else empty end')
  JSON_BODY=$(printf '%s' "$J" | jq -c 'del(.action, .id, .shippedAt, .status, .reason)')
fi
if [[ -z "$ACTION" && $# -gt 0 && ${1:0:1} != '-' ]]; then ACTION="$1"; shift; fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)            [ $# -ge 2 ] || error_exit "--id requires a value"; ID="$2"; shift 2 ;;
    --hypothesis)    [ $# -ge 2 ] || error_exit "--hypothesis requires a value"; HYPOTHESIS="$2"; shift 2 ;;
    --title)         [ $# -ge 2 ] || error_exit "--title requires a value"; TITLE="$2"; shift 2 ;;
    --source)        [ $# -ge 2 ] || error_exit "--source requires a value"; SOURCE="$2"; shift 2 ;;
    --measure)       [ $# -ge 2 ] || error_exit "--measure requires a value"; MEASURE="$2"; shift 2 ;;
    --config)        [ $# -ge 2 ] || error_exit "--config requires a value"; CONFIG="$2"; shift 2 ;;
    --page)          [ $# -ge 2 ] || error_exit "--page requires a value"; PAGE="$2"; shift 2 ;;
    --page-match)    [ $# -ge 2 ] || error_exit "--page-match requires a value"; PAGE_MATCH="$2"; shift 2 ;;
    --query)         [ $# -ge 2 ] || error_exit "--query requires a value"; QUERY="$2"; shift 2 ;;
    --query-match)   [ $# -ge 2 ] || error_exit "--query-match requires a value"; QUERY_MATCH="$2"; shift 2 ;;
    --event)         [ $# -ge 2 ] || error_exit "--event requires a value"; EVENT="$2"; shift 2 ;;
    --channel)       [ $# -ge 2 ] || error_exit "--channel requires a value"; CHANNEL="$2"; shift 2 ;;
    --label)         [ $# -ge 2 ] || error_exit "--label requires a value"; LABEL="$2"; shift 2 ;;
    --from)          [ $# -ge 2 ] || error_exit "--from requires a value"; FROM="$2"; shift 2 ;;
    --to)            [ $# -ge 2 ] || error_exit "--to requires a value"; TO="$2"; shift 2 ;;
    --direction)     [ $# -ge 2 ] || error_exit "--direction requires a value"; DIRECTION="$2"; shift 2 ;;
    --window-days)   [ $# -ge 2 ] || error_exit "--window-days requires a value"; WINDOW="$2"; shift 2 ;;
    --confidence)    [ $# -ge 2 ] || error_exit "--confidence requires a value"; CONFIDENCE="$2"; shift 2 ;;
    --project|-p)    [ $# -ge 2 ] || error_exit "--project requires a value"; PROJECT="$2"; shift 2 ;;
    --ticket)        [ $# -ge 2 ] || error_exit "--ticket requires a value"; TICKET="$2"; shift 2 ;;
    --tkt)           [ $# -ge 2 ] || error_exit "--tkt requires a value"; TKT="$2"; shift 2 ;;
    --shipped-at)    [ $# -ge 2 ] || error_exit "--shipped-at requires a value"; SHIPPED_AT="$2"; shift 2 ;;
    --status)        [ $# -ge 2 ] || error_exit "--status requires a value"; STATUS="$2"; shift 2 ;;
    --reason)        [ $# -ge 2 ] || error_exit "--reason requires a value"; REASON="$2"; shift 2 ;;
    --help|-h)       print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

enc() { jq -rn --arg v "$1" '$v|@uri'; }
CARD='{id, status, title, hypothesis, metric: (.metric | {source, measure, page, query, event, label} | with_entries(select(.value != null))), windowDays, ticket, shippedAt, dueAt, baseline: (.baseline.total // null), result: (.result.total // null), verdict, verdictReason, lastError, traceId}'

case "$ACTION" in
  create)
    if [ -n "$JSON_BODY" ] && [ "$JSON_BODY" != "{}" ]; then
      BODY="$JSON_BODY"
    else
      require_param "hypothesis (--hypothesis)" "$HYPOTHESIS"
      require_param "source (--source gsc|ga4)" "$SOURCE"
      require_param "measure (--measure)" "$MEASURE"
      require_param "config (--config, the seo-ops site config)" "$CONFIG"
      if [ -n "$TICKET" ] && [ -z "$PROJECT" ]; then error_exit "--ticket needs --project (or use --tkt TKT-n for a harness ticket)"; fi
      BODY=$(jq -cn \
        --arg h "$HYPOTHESIS" --arg t "$TITLE" --arg s "$SOURCE" --arg m "$MEASURE" --arg c "$CONFIG" \
        --arg page "$PAGE" --arg pm "$PAGE_MATCH" --arg q "$QUERY" --arg qm "$QUERY_MATCH" --arg ev "$EVENT" \
        --arg ch "$CHANNEL" --arg lb "$LABEL" --arg from "$FROM" --arg to "$TO" --arg dir "$DIRECTION" \
        --arg win "$WINDOW" --arg conf "$CONFIDENCE" --arg proj "$PROJECT" --arg tic "$TICKET" --arg tkt "$TKT" '
        def opt($k; $v): if $v == "" then {} else {($k): $v} end;
        {hypothesis: $h}
        + opt("title"; $t)
        + {metric: ({source: $s, measure: $m, config: $c}
            + opt("page"; $page) + opt("pageMatch"; $pm) + opt("query"; $q) + opt("queryMatch"; $qm)
            + opt("event"; $ev) + opt("channel"; $ch) + opt("label"; $lb))}
        + (if $from == "" and $to == "" then {} else {expected: (opt("from"; $from) + opt("to"; $to))} end)
        + opt("direction"; $dir) + opt("windowDays"; $win) + opt("confidence"; $conf)
        + (if $tkt != "" then {ticket: {kind: "harness", id: $tkt}}
           elif $tic != "" then {ticket: {kind: "project", project: $proj, id: $tic}}
           else {} end)')
    fi
    api_call POST "/experiments" "$BODY" | jq "{success, experiment: (.data | ${CARD})}"
    ;;
  ship)
    require_param "id (--id EXP-n)" "$ID"
    BODY=$(jq -cn --arg at "$SHIPPED_AT" 'if $at == "" then {} else {shippedAt: $at} end')
    api_call POST "/experiments/$(enc "$ID")/ship" "$BODY" | jq "{success, experiment: (.data | ${CARD})}"
    ;;
  show)
    require_param "id (--id EXP-n)" "$ID"
    api_call GET "/experiments/$(enc "$ID")" | jq "{success, experiment: (.data | ${CARD} + {timeline})}"
    ;;
  list)
    QS=""
    [ -n "$STATUS" ] && QS="status=$(enc "$STATUS")"
    [ -n "$TICKET" ] && QS="${QS:+$QS&}ticket=$(enc "$TICKET")"
    api_call GET "/experiments${QS:+?$QS}" | jq "{success, experiments: [.data[] | ${CARD}]}"
    ;;
  measure)
    require_param "id (--id EXP-n)" "$ID"
    api_call POST "/experiments/$(enc "$ID")/measure" '{}' | jq "{success, experiment: (.data | ${CARD})}"
    ;;
  cancel)
    require_param "id (--id EXP-n)" "$ID"
    BODY=$(jq -cn --arg r "$REASON" 'if $r == "" then {} else {reason: $r} end')
    api_call POST "/experiments/$(enc "$ID")/cancel" "$BODY" | jq "{success, experiment: (.data | ${CARD})}"
    ;;
  ""|help) print_usage; [ -n "$ACTION" ] || exit 1 ;;
  *) error_exit "Unknown action: $ACTION (create, ship, show, list, measure, cancel)" ;;
esac
