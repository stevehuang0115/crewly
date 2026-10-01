#!/bin/bash
# ask-owner — one structured owner decision (question + 2–3 options + default
# + deadline), posted as a Slack card by the asking agent's own bot.
# See specs/2026-10-01-decision-cards.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --question "Send the partner email on Monday?" \
    --option "Send Monday — after the review call" --option "Hold — wait for legal" \
    --default "Hold" [--deadline 2026-10-02T12:00] [--ticket APP-12 --project P] \
    [--sensitive email|publish|deploy|spend]
  bash execute.sh --cancel D-7          Withdraw a question you no longer need
  bash execute.sh '{"question":"…","options":["A","B"],"default":"A"}'
EOF_USAGE
}

QUESTION=""; OPTIONS_JSON="[]"; DEFAULT_OPT=""; DEADLINE=""; SENSITIVE=""; TICKET=""; PROJECT=""; CANCEL=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  J="$1"; shift
  QUESTION=$(printf '%s' "$J" | jq -r '.question // empty')
  OPTIONS_JSON=$(printf '%s' "$J" | jq -c 'if (.options|type) == "array" then .options else [] end')
  DEFAULT_OPT=$(printf '%s' "$J" | jq -r '.default // empty')
  DEADLINE=$(printf '%s' "$J" | jq -r '.deadline // empty')
  SENSITIVE=$(printf '%s' "$J" | jq -r '.sensitive // empty')
  TICKET=$(printf '%s' "$J" | jq -r '.ticket // empty')
  PROJECT=$(printf '%s' "$J" | jq -r '.project // empty')
  CANCEL=$(printf '%s' "$J" | jq -r '.cancel // empty')
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --question|-q)  [ $# -ge 2 ] || error_exit "--question requires a value"; QUESTION="$2"; shift 2 ;;
    --option|-o)    [ $# -ge 2 ] || error_exit "--option requires a value"
                    OPTIONS_JSON=$(jq -c --arg o "$2" '. + [$o]' <<<"$OPTIONS_JSON"); shift 2 ;;
    --default|-d)   [ $# -ge 2 ] || error_exit "--default requires a value"; DEFAULT_OPT="$2"; shift 2 ;;
    --deadline)     [ $# -ge 2 ] || error_exit "--deadline requires a value"; DEADLINE="$2"; shift 2 ;;
    --sensitive)    [ $# -ge 2 ] || error_exit "--sensitive requires a value"; SENSITIVE="$2"; shift 2 ;;
    --ticket|--id)  [ $# -ge 2 ] || error_exit "--ticket requires a value"; TICKET="$2"; shift 2 ;;
    --project|-p)   [ $# -ge 2 ] || error_exit "--project requires a value"; PROJECT="$2"; shift 2 ;;
    --cancel)       [ $# -ge 2 ] || error_exit "--cancel requires a decision id"; CANCEL="$2"; shift 2 ;;
    --help|-h)      print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1 (see --help)" ;;
  esac
done

if [ -n "$CANCEL" ]; then
  api_call POST "/decisions/$(printf '%s' "$CANCEL" | jq -sRr @uri)/cancel" '{}' | jq '{success, decision: (.data | {id, status})}'
  exit 0
fi

require_param "question" "$QUESTION"
BODY=$(jq -n --arg q "$QUESTION" --argjson o "$OPTIONS_JSON" --arg d "$DEFAULT_OPT" --arg dl "$DEADLINE" \
  --arg s "$SENSITIVE" --arg t "$TICKET" --arg p "$PROJECT" \
  '{question: $q, options: $o}
   + (if $d != "" then {default: $d} else {} end)
   + (if $dl != "" then {deadline: $dl} else {} end)
   + (if $s != "" then {sensitive: $s} else {} end)
   + (if $t != "" then {ticket: $t} else {} end)
   + (if $p != "" then {project: $p} else {} end)')
api_call POST "/decisions" "$BODY" \
  | jq '{success, decision: (.data | {id, asker, status, deadline, posted: (.card != null), postError})}'
