#!/bin/bash
# =============================================================================
# harness-login — start the harness login (or account switch) the owner asked
# for: Claude Code, Codex. Backed by POST /api/harness/<id>/owner-login.
#
# Crewly runs the login in its own terminal and keeps it alive, DMs the owner
# the link (and Codex's code) in the thread they asked in, types the code they
# paste back into the login, and tells them itself when it worked or failed.
# This returns at once. After it succeeds, say NOTHING more about the login —
# no link, no "I've sent it", no status report.
#
# NEVER run `claude setup-token`, `claude /login`, `claude auth login`,
# `codex login` or an agy login in bash: that process dies when the tool call
# returns, so every code the owner pastes goes stale.
#
# Only works when the owner asked for the login in the last 30 minutes (their
# message is checked). Orchestrator only.
#
# Usage:
#   bash execute.sh --harness claude
#   bash execute.sh --harness codex --switch-account
#   bash execute.sh --harness claude --account work   # another of the owner's Claude accounts
#   bash execute.sh '{"harness":"claude","switchAccount":true}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --harness <claude|codex|antigravity> [--switch-account] [--account <name>]
  bash execute.sh '{"harness":"claude","switchAccount":false,"account":"work"}'

Options:
  --harness         claude (Claude Code), codex (Codex CLI) or antigravity (agy) — required
  --switch-account  The owner wants a different account (changes the wording of the DM)
  --account         Sign in another of the owner's own Claude Code accounts (used as a
                    runtime fallback, chain entry claude-code@<name>) instead of the default login
  --help | -h       Show this help
EOF_USAGE
}

INPUT_JSON=""; HARNESS=""; SWITCH=false; ACCOUNT=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --harness)        [ $# -ge 2 ] || error_exit "--harness requires a value"; HARNESS="$2"; shift 2 ;;
    --switch-account) SWITCH=true; shift ;;
    --account)        [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h)        print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$HARNESS" ] && HARNESS=$(printf '%s' "$INPUT" | jq -r '.harness // .harnessId // empty')
  [ "$(printf '%s' "$INPUT" | jq -r '.switchAccount // false')" = "true" ] && SWITCH=true
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
require_param "harness (--harness)" "$HARNESS"

# "Claude Code" → "claude-code"; anything else than [a-z0-9-] never reaches the URL.
HARNESS_ID=$(printf '%s' "$HARNESS" | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]_]+/-/g')
[[ "$HARNESS_ID" =~ ^[a-z0-9-]+$ ]] || error_exit "Invalid harness: $HARNESS (use claude, codex or antigravity)"

ACCOUNT=$(printf '%s' "$ACCOUNT" | tr '[:upper:]' '[:lower:]')
[ -z "$ACCOUNT" ] || [[ "$ACCOUNT" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || error_exit "Invalid account: $ACCOUNT (lower-case letters, digits, - or _)"

BODY=$(jq -cn --argjson sw "$SWITCH" --arg acct "$ACCOUNT" '{switchAccount: $sw} + (if $acct != "" then {account: $acct} else {} end)')

ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call POST "/harness/${HARNESS_ID}/owner-login" "$BODY" 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{success: false,
      reason: (.details.code // "login_not_started"),
      error: (.details.error // .error // "login not started")}
    + (if .details.next then {next: .details.next} else {} end)' 2>/dev/null \
    || jq -cn --arg e "$ERR" '{success: false, reason: "login_not_started", error: $e}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c '.data | {success: true} + .'
