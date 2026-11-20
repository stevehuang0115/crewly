#!/bin/bash
# Create a Slack channel with named agents (any team, any machine), or add
# agents to an existing channel.
#   execute.sh --name <channel> --members "Owen,Growth Team Lead" [--purpose "..."]
#   execute.sh --add <channel> --members "Owen"
# Names may be display names, session names or "<team> Lead". Agents on other
# machines join through Crewly Cloud. Prints who was added, who was asked of
# another machine, and who could not be found — so you can tell the owner.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

NAME=""; ADD=""; MEMBERS=""; PURPOSE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name|-n) NAME="${2:-}"; shift 2 ;;
    --add|-a) ADD="${2:-}"; shift 2 ;;
    --members|-m) MEMBERS="${2:-}"; shift 2 ;;
    --purpose|-p) PURPOSE="${2:-}"; shift 2 ;;
    --help|-h)
      echo 'Usage: bash execute.sh --name <channel> --members "Owen,Growth Team Lead" [--purpose "..."]'
      echo '       bash execute.sh --add <existing channel> --members "Owen"'
      exit 0 ;;
    *) shift ;;
  esac
done

if [ -z "$MEMBERS" ] || { [ -z "$NAME" ] && [ -z "$ADD" ]; }; then
  echo "Error: --members and one of --name (new channel) or --add (existing channel) are required" >&2
  exit 1
fi

# Comma / semicolon / newline separated, trimmed, empty dropped.
MEMBERS_JSON=$(printf '%s' "$MEMBERS" | tr ';\n' ',,' | jq -R -c 'split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length > 0))')
if [ -n "$ADD" ]; then
  BODY=$(jq -n -c --arg channel "$ADD" --argjson members "$MEMBERS_JSON" '{channel: $channel, members: $members}')
else
  BODY=$(jq -n -c --arg name "$NAME" --arg purpose "$PURPOSE" --argjson members "$MEMBERS_JSON" \
    '{name: $name, members: $members} + (if $purpose == "" then {} else {purpose: $purpose} end)')
fi

# Test hook: print the request instead of calling the backend.
if [ "${CREWLY_SKILL_DRY_RUN:-}" = "1" ]; then
  echo "POST /channels/compose $BODY"
  exit 0
fi

# Test hook: format a canned backend response instead of calling the backend.
if [ -n "${CREWLY_SKILL_FAKE_RESPONSE:-}" ]; then
  RAW="$CREWLY_SKILL_FAKE_RESPONSE"
else
  RAW=$(api_call POST "/channels/compose" "$BODY")
fi
printf '%s' "$RAW" | jq -r '
  if .success == true then
    .data as $d
    | "Channel #\($d.channel.name) " + (if $d.channel.created then "created" else "updated" end) + (if $d.channel.slackChannelId then " (Slack \($d.channel.slackChannelId))" else " (Crewly-only, Slack is not connected)" end),
      ($d.added[] | "ADDED: \(.name) (\(.team // "?"), \(.machine // "?"))"),
      ($d.requested[] | "ASKED (joins on its own machine shortly): \(.name) (\(.machine // "?"))"),
      ($d.failed[] | "FAILED: \(.name) — \(.reason)"),
      ($d.ambiguous[] | "AMBIGUOUS: \(.term) — could be: \(.candidates | join("; "))"),
      ($d.notFound[] | "NOT FOUND: \(.)"),
      (if $d.directoryUnavailable then "NOTE: the cross-machine directory is unavailable (not signed in to Crewly Cloud), so agents on other machines could not be looked up." else empty end),
      (if ($d.failed + $d.ambiguous + $d.notFound | length) > 0 then "-> Tell the owner plainly which names were not added and why; do not leave them waiting." else empty end)
  else
    "ERROR: \(.message // .error // "request failed")" + (if .error == "owner_only" then " (only the orchestrator and the owner may do this)" else "" end)
  end'
