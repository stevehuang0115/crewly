#!/bin/bash
# Make a member the lead of its team (specs/2026-09-30-team-lead-rule.md).
#
# Usage:
#   execute.sh --team <name|id> --member <name|session|id> [--add]
#   execute.sh '{"team":"CE","member":"Owen","mode":"set"}'
#
# `--add` (mode "add") keeps the current leads and adds this one; the default
# (mode "set") makes the member THE lead. Calls POST /api/teams/:team/lead as
# the orchestrator (api_call sends X-Agent-Session); other agents get 403.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

TEAM=""
MEMBER=""
MODE="set"

if [ "${1:-}" != "" ] && [[ "${1}" == --* ]]; then
  while [ $# -gt 0 ]; do
    case "$1" in
      --team) TEAM="${2:-}"; shift 2 ;;
      --member) MEMBER="${2:-}"; shift 2 ;;
      --add) MODE="add"; shift ;;
      --mode) MODE="${2:-}"; shift 2 ;;
      *) error_exit "Unknown option: $1 (use --team, --member, --add)" ;;
    esac
  done
else
  INPUT=$(read_json_input "${1:-}")
  [ -z "$INPUT" ] && error_exit "Usage: execute.sh --team <name|id> --member <name|session> [--add]"
  TEAM=$(printf '%s' "$INPUT" | jq -r '.team // .teamId // empty')
  MEMBER=$(printf '%s' "$INPUT" | jq -r '.member // .memberId // empty')
  MODE=$(printf '%s' "$INPUT" | jq -r '.mode // "set"')
fi

require_param "team" "$TEAM"
require_param "member" "$MEMBER"
if [ "$MODE" != "set" ] && [ "$MODE" != "add" ]; then
  error_exit "mode must be \"set\" or \"add\" (got: \"${MODE}\")"
fi

TEAM_PATH=$(jq -rn --arg t "$TEAM" '$t | @uri')
BODY=$(jq -n --arg member "$MEMBER" --arg mode "$MODE" '{member: $member, mode: $mode}')

api_call POST "/teams/${TEAM_PATH}/lead" "$BODY"
