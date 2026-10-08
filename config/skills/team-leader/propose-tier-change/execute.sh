#!/bin/bash
# propose-tier-change — a team lead proposes model-tier changes and task
# routing rules for its team (crewly#1173). Proposals collect in a draft;
# --submit sends ONE owner card with all of them. Nothing changes until the
# owner taps Apply. See specs/2026-10-08-model-tiers.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --member "Ella" --tier weak --reason "only polls the inbox and sorts tickets"
  bash execute.sh --routing "polling / formatting / sorting -> Ella"
  bash execute.sh --submit          Send the draft to the owner (one card). With nothing proposed, closes the review.
  bash execute.sh --clear           Drop the draft without sending it.
  bash execute.sh '{"member":"Ella","tier":"weak","reason":"..."}'
Tiers: strong (hard reasoning, design, review), mid (normal work), weak (routine: polling, checks, formatting, sorting, triage).
EOF_USAGE
}

MEMBER=""; TIER=""; REASON=""; ROUTING=""; SUBMIT=""; CLEAR=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  J="$1"; shift
  MEMBER=$(printf '%s' "$J" | jq -r '.member // empty')
  TIER=$(printf '%s' "$J" | jq -r '.tier // empty')
  REASON=$(printf '%s' "$J" | jq -r '.reason // empty')
  ROUTING=$(printf '%s' "$J" | jq -r '.routing // empty')
  [ "$(printf '%s' "$J" | jq -r '.submit // false')" = "true" ] && SUBMIT=1
  [ "$(printf '%s' "$J" | jq -r '.clear // false')" = "true" ] && CLEAR=1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --member|-m)  [ $# -ge 2 ] || error_exit "--member requires a value"; MEMBER="$2"; shift 2 ;;
    --tier|-t)    [ $# -ge 2 ] || error_exit "--tier requires a value"; TIER=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]'); shift 2 ;;
    --reason|-r)  [ $# -ge 2 ] || error_exit "--reason requires a value"; REASON="$2"; shift 2 ;;
    --routing)    [ $# -ge 2 ] || error_exit "--routing requires a value"; ROUTING="$2"; shift 2 ;;
    --submit)     SUBMIT=1; shift ;;
    --clear)      CLEAR=1; shift ;;
    --help|-h)    print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1 (see --help)" ;;
  esac
done

if [ -n "$CLEAR" ]; then
  BODY='{"clear":true}'
elif [ -n "$SUBMIT" ]; then
  BODY='{"submit":true}'
elif [ -n "$ROUTING" ]; then
  BODY=$(jq -n --arg r "$ROUTING" '{routing: $r}')
else
  require_param "member" "$MEMBER"
  require_param "tier" "$TIER"
  require_param "reason" "$REASON"
  case "$TIER" in
    strong|mid|weak) ;;
    *) error_exit "Invalid tier '${TIER}': use strong, mid or weak" ;;
  esac
  BODY=$(jq -n --arg m "$MEMBER" --arg t "$TIER" --arg r "$REASON" '{member: $m, tier: $t, reason: $r}')
fi

api_call POST "/teams/model-tiers/proposals" "$BODY"
