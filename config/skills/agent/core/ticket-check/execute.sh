#!/bin/bash
# =============================================================================
# ticket-check — read a ticket's acceptance criteria / record a self-check
#
# Backed by GET /api/tickets/:tkt and POST /api/tickets/:id/self-check
# (specs/ticket-loop.md, Phase 2).
#
# Usage:
#   bash execute.sh --ticket TKT-012
#   bash execute.sh --ticket TKT-012 --index 1 --result pass|fail [--evidence "…"]
#   bash execute.sh '{"ticket":"TKT-012","index":1,"result":"pass","evidence":"…"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --ticket TKT-012                      List the live acceptance criteria
  bash execute.sh --ticket TKT-012 --index 1 --result pass [--evidence "what you checked"]

Options:
  --ticket     TKT-012, 12 or the ticket id (required)
  --index      Criterion number from the list (0-based)
  --result     pass | fail
  --evidence   What you looked at / ran
  --help | -h  Show this help
EOF_USAGE
}

TICKET=""; INDEX=""; RESULT=""; EVIDENCE=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  TICKET=$(printf '%s' "$1" | jq -r '.ticket // .requestId // empty')
  INDEX=$(printf '%s' "$1" | jq -r 'if has("index") then (.index|tostring) else empty end')
  RESULT=$(printf '%s' "$1" | jq -r '.result // empty')
  EVIDENCE=$(printf '%s' "$1" | jq -r '.evidence // empty')
  shift || true
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket|--request-id) [ $# -ge 2 ] || error_exit "--ticket requires a value";   TICKET="$2";   shift 2 ;;
    --index)               [ $# -ge 2 ] || error_exit "--index requires a value";    INDEX="$2";    shift 2 ;;
    --result)              [ $# -ge 2 ] || error_exit "--result requires a value";   RESULT="$2";   shift 2 ;;
    --evidence)            [ $# -ge 2 ] || error_exit "--evidence requires a value"; EVIDENCE="$2"; shift 2 ;;
    --help|-h)             print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

require_param "ticket" "$TICKET"

# List mode.
if [ -z "$INDEX" ] && [ -z "$RESULT" ]; then
  api_call GET "/tickets/${TICKET}" | jq '(.data.board // {}) | {
    tkt, title, column,
    acceptance: [(.acceptance // [])[] ] | to_entries | map({index: .key} + .value)
  }'
  exit 0
fi

[[ "$INDEX" =~ ^[0-9]+$ ]] || error_exit "--index must be a number from the list (0-based)"
[[ "$RESULT" == "pass" || "$RESULT" == "fail" ]] || error_exit "--result must be pass or fail"

# The self-check endpoint takes the ticket id; resolve TKT-… first.
ID=$(api_call GET "/tickets/${TICKET}" | jq -r '.data.ticket.id // empty')
[ -n "$ID" ] || error_exit "Ticket not found: ${TICKET}"

BODY=$(jq -n --argjson index "$INDEX" --arg result "$RESULT" --arg evidence "$EVIDENCE" \
  '{index: $index, result: $result} + (if $evidence == "" then {} else {evidence: $evidence} end)')
api_call POST "/tickets/${ID}/self-check" "$BODY" | jq '{success, acceptance: (.data.acceptance // [])}'
