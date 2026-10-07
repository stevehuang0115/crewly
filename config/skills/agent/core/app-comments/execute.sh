#!/bin/bash
# =============================================================================
# app-comments — the owner's comments on a Crewly App you published: list
# them (with the element each one points at), reply in a thread, resolve or
# reopen. Only the owner starts a comment (comment mode in the app). An agent
# the owner @mentioned in a thread may --get / --reply / --resolve / --reopen
# it even when the app is not its team's (not --list).
#
# Backed by /api/apps/:appId/comments…; the backend calls Crewly Cloud with
# its own login. crewly#1056, crewly-services apps/SPEC.md §12.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --app <appId> --list [--status open|resolved|all]
  bash execute.sh --app <appId> --get <commentId>
  bash execute.sh --app <appId> --reply <commentId> --text "Made it green in version 5."
  bash execute.sh --app <appId> --resolve <commentId> [--text "what you changed"]
  bash execute.sh --app <appId> --reopen <commentId>
  bash execute.sh --app <appId> --audio <commentId>     # download its voice recordings; prints local paths

Options:
  --app        App id (from publish-app)
  --status     Which threads --list shows (default open)
  --text       Reply text (≤ 2000 characters). With --resolve it is posted as a reply first
  --help | -h  Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, status: (.status // 0), reason: (.details.error // .error // "unknown"), message: (.details.message // .details // ""), hint: (.details.hint // "")}' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s\n' "$out" | tail -n 1)"; }
  printf '%s\n' "$out" | tail -n 1
}

# A thread, compact: who wrote what, and the full anchor (the element in the app).
# `to` lists the agents the owner @mentioned (only when there are any).
# `voice` lists voice recordings (fetch them with --audio <id>, then transcribe).
THREAD='({id, number, status, version, on: .anchor, comment: .body, at: .createdAt}
  + (if ((.mentions // []) | length) > 0 then {to: [.mentions[].name]} else {} end)
  + (if ((.attachments // []) | length) > 0 then {voice: [.attachments[] | select(.kind == "audio") | {seconds: ((.durationMs // 0) / 1000 | floor)}]} else {} end)
  + {replies: [.replies[]? | ({from: (if .author.kind == "owner" then "owner" else (.author.name // "agent") end), text: .body, at: .createdAt}
      + (if ((.mentions // []) | length) > 0 then {to: [.mentions[].name]} else {} end)
      + (if ((.attachments // []) | length) > 0 then {voice: [.attachments[] | select(.kind == "audio") | {seconds: ((.durationMs // 0) / 1000 | floor)}]} else {} end))],
  resolvedBy: (if .resolvedBy then (if .resolvedBy.kind == "owner" then "owner" else .resolvedBy.name end) else null end)})'

APP=""; OP=""; ID=""; STATUS=""; TEXT=""; HAS_TEXT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)    [ $# -ge 2 ] || error_exit "--app requires a value"; APP="$2"; shift 2 ;;
    --list)   OP="list"; shift ;;
    --get|--reply|--resolve|--reopen|--audio)
      [ $# -ge 2 ] || error_exit "$1 requires a comment id"
      OP="${1#--}"; ID="$2"; shift 2 ;;
    --status) [ $# -ge 2 ] || error_exit "--status requires a value"; STATUS="$2"; shift 2 ;;
    --text)   [ $# -ge 2 ] || error_exit "--text requires a value"; TEXT="$2"; HAS_TEXT=1; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

[ -n "$APP" ] || error_exit "--app is required"
[ -n "$OP" ] || error_exit "one of --list / --get / --reply / --resolve / --reopen / --audio is required"
[[ "$APP" =~ ^[a-z0-9]{10}$ ]] || error_exit "--app must be a 10-character app id"
if [ -n "$ID" ]; then
  [[ "$ID" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || error_exit "comment id must be the id from --list"
fi
if [ "$HAS_TEXT" = 1 ]; then
  [ -n "${TEXT// /}" ] || error_exit "--text is empty"
  [ "$(printf '%s' "$TEXT" | jq -Rs 'length')" -le 2000 ] || error_exit "--text is at most 2000 characters"
fi
BASE="/apps/${APP}/comments"

reply() {
  call POST "${BASE}/${ID}/replies" "$(jq -cn --arg t "$TEXT" '{text: $t}')"
}

case "$OP" in
  list)
    case "${STATUS:-open}" in open|resolved|all) ;; *) error_exit "--status is open, resolved or all" ;; esac
    RESPONSE=$(call GET "${BASE}?status=${STATUS:-open}") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c "{success: true, comments: [.data.comments[]? | $THREAD]}"
    ;;
  get)
    RESPONSE=$(call GET "${BASE}/${ID}") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c "{success: true, comment: (.data | $THREAD)}"
    ;;
  reply)
    [ "$HAS_TEXT" = 1 ] || error_exit "--reply needs --text"
    RESPONSE=$(reply) || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, id: .data.id, number: .data.number, replies: (.data.replies | length), status: .data.status}'
    ;;
  audio)
    RESPONSE=$(call POST "${BASE}/${ID}/audio" '{}') || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, recordings: .data.recordings,
      next: (if ((.data.recordings // []) | length) == 0 then "This thread has no voice recordings." else "Transcribe each path with the transcribe-audio skill ({\"audioFile\": \"<path>\"}) before acting." end)}'
    ;;
  resolve|reopen)
    if [ "$HAS_TEXT" = 1 ]; then
      R=$(reply) || { printf '%s\n' "$R"; exit 1; }
    fi
    RESPONSE=$(call POST "${BASE}/${ID}/${OP}") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, id: .data.id, number: .data.number, status: .data.status, replies: (.data.replies | length)}'
    ;;
esac
