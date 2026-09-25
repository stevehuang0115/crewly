#!/bin/bash
# =============================================================================
# install-skill — install a skill and its dependencies as a background job.
#
# Returns at once with a job id (or "already-ready"). When the job ends you get
# a message: [SKILL INSTALLED] … or [SKILL INSTALL FAILED] … with the reason.
# Tell the user in one line that you are installing it, then continue with
# other work or wait; resume the paused task when the message arrives.
# Backed by POST /api/skill-setup/install.
#
# Only official skills (bundled with Crewly, or published by the Crewly Team in
# the official registry) install without asking. A third-party skill needs the
# owner's yes in chat first; then pass --approved-by-owner (it is checked
# against the owner's chat history — claiming it without their yes fails).
#
# Usage:
#   bash execute.sh --id transcribe-audio --resume "transcribe clip.m4a for Steve"
#   bash execute.sh --id some-skill --approved-by-owner --owner-said "好的，装 some-skill"
#   bash execute.sh '{"id":"pdf-tools","resume":"…"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id <skill-id> [--resume "what you were doing"] [--approved-by-owner --owner-said "…"] [--force]
  bash execute.sh '{"id":"…","resume":"…","approvedByOwner":false}'

Options:
  --id                 Skill id from find-skill (required)
  --resume             What you were doing; echoed back in the completion message
  --approved-by-owner  The owner said yes in chat (third-party skills only; verified)
  --owner-said         Quote the owner's yes (recorded next to the verified message)
  --force              Re-run setup even if everything looks installed
  --help | -h          Show this help
EOF_USAGE
}

INPUT_JSON=""; ID=""; RESUME=""; APPROVED=false; FORCE=false; OWNER_SAID=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)                [ $# -ge 2 ] || error_exit "--id requires a value"; ID="$2"; shift 2 ;;
    --resume)            [ $# -ge 2 ] || error_exit "--resume requires a value"; RESUME="$2"; shift 2 ;;
    --approved-by-owner) APPROVED=true; shift ;;
    --owner-said)        [ $# -ge 2 ] || error_exit "--owner-said requires a value"; OWNER_SAID="$2"; shift 2 ;;
    --force)             FORCE=true; shift ;;
    --help|-h)           print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ID" ] && ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
  [ -z "$RESUME" ] && RESUME=$(printf '%s' "$INPUT" | jq -r '.resume // empty')
  [ "$(printf '%s' "$INPUT" | jq -r '.approvedByOwner // false')" = "true" ] && APPROVED=true
  [ "$(printf '%s' "$INPUT" | jq -r '.force // false')" = "true" ] && FORCE=true
fi
require_param "id (--id)" "$ID"
# The quote travels as X-Agent-Authorization (lib.sh encodes it): recorded, never trusted.
[ -n "$OWNER_SAID" ] && export CREWLY_AGENT_AUTHORIZATION="$OWNER_SAID"

BODY=$(jq -cn --arg id "$ID" --arg resume "$RESUME" --argjson approved "$APPROVED" --argjson force "$FORCE" \
  '{id: $id} + (if $resume != "" then {resume: $resume} else {} end)
   + (if $approved then {approvedByOwner: true} else {} end) + (if $force then {force: true} else {} end)')

ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call POST "/skill-setup/install" "$BODY" 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{success: false,
      reason: (.details.code // "install_failed"),
      error: (.details.error // .error // "install failed")}
    + (if (.details.code // "") | startswith("owner_approval") then {official: false, next: "Ask the owner in chat before installing this third-party skill."} else {} end)' 2>/dev/null \
    || jq -cn --arg e "$ERR" '{success: false, reason: "install_failed", error: $e}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '.data | {success: true} + .'
