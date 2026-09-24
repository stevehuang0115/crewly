#!/bin/bash
# =============================================================================
# todo-lists — List the owner's Microsoft To Do lists, or create one
#
# Backed by GET / POST /api/microsoft-todo/lists.
#
# Usage:
#   bash execute.sh
#   bash execute.sh --create "Trip to Lisbon"
#   bash execute.sh '{"create":"Trip to Lisbon"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh
  bash execute.sh --create "Trip to Lisbon"
  bash execute.sh '{"create":"Trip to Lisbon"}'

Options:
  --create      Create a list with this name instead of listing
  --help | -h   Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")} + (if (.details | type) == "object" and .details.retryAfter then {retryAfter: .details.retryAfter} else {} end)' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# api_call may print a one-line warning to stderr (no CREWLY_SESSION_NAME);
# the backend answer is always the last line. On failure print the mapped
# failure JSON (fail_from) and return 1.
call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s\n' "$out" | tail -n 1)"; }
  printf '%s\n' "$out" | tail -n 1
}

INPUT_JSON=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi
CREATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --create)  [ $# -ge 2 ] || error_exit "--create requires a value"; CREATE="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$CREATE" ] && CREATE=$(printf '%s' "$INPUT" | jq -r '.create // .name // empty')
fi
if [ -n "$CREATE" ]; then
  BODY=$(jq -cn --arg name "$CREATE" '{name: $name}')
  RESPONSE=$(call POST "/microsoft-todo/lists" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: true, list: .data}'
  exit 0
fi
RESPONSE=$(call GET "/microsoft-todo/lists") || { printf '%s\n' "$RESPONSE"; exit 1; }
printf '%s' "$RESPONSE" | jq -c '{count: .data.count, lists: .data.lists}'
