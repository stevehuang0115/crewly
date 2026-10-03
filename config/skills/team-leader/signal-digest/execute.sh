#!/bin/bash
# =============================================================================
# signal-digest — a site's daily signals → 3–5 actions → one owner card (#987)
#
#   collect   GA4 + Search Console + the site inbox + broken pages / JS errors,
#             minus what was already tried; prints JSON with draft actions.
#   propose   send 3–5 actions; the owner gets one Slack card with Do / Skip
#             per action (Do opens an experiment ticket in the site's project).
#   schedule  print the daily cron task for the orchestrator to create.
#
# Usage:
#   bash execute.sh collect  --config site.signal.json [--days 7]
#   bash execute.sh propose  --config site.signal.json --actions actions.json
#   bash execute.sh schedule --config site.signal.json [--cron "0 8 * * *"] [--timezone America/New_York]
#   bash execute.sh '{"command":"collect","config":"site.signal.json"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

DEFAULT_CRON="0 8 * * *"
DEFAULT_TIMEZONE="America/New_York"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh collect  --config site.signal.json [--days 7]
  bash execute.sh propose  --config site.signal.json --actions actions.json   (file, or inline JSON)
  bash execute.sh schedule --config site.signal.json [--cron "0 8 * * *"] [--timezone America/New_York]
  bash execute.sh '{"command":"collect","config":"site.signal.json"}'

The config is the site's seo-ops config plus a "signalDigest" section
(see signal-digest.config.example.json).
EOF_USAGE
}

COMMAND=""; CONFIG=""; DAYS=""; ACTIONS=""; CRON=""; TIMEZONE=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT=$(read_json_input "$1")
  shift || true
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.command // empty')
  CONFIG=$(printf '%s' "$INPUT" | jq -r '.config // empty')
  DAYS=$(printf '%s' "$INPUT" | jq -r '.days // empty')
  ACTIONS=$(printf '%s' "$INPUT" | jq -r 'if .actions == null then empty elif (.actions | type) == "string" then .actions else (.actions | tojson) end')
  CRON=$(printf '%s' "$INPUT" | jq -r '.cron // empty')
  TIMEZONE=$(printf '%s' "$INPUT" | jq -r '.timezone // empty')
elif [[ $# -gt 0 && ${1:0:1} != '-' ]]; then
  COMMAND="$1"
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config|-c)  [ $# -ge 2 ] || error_exit "--config requires a value";   CONFIG="$2";   shift 2 ;;
    --days)       [ $# -ge 2 ] || error_exit "--days requires a value";     DAYS="$2";     shift 2 ;;
    --actions)    [ $# -ge 2 ] || error_exit "--actions requires a value";  ACTIONS="$2";  shift 2 ;;
    --cron)       [ $# -ge 2 ] || error_exit "--cron requires a value";     CRON="$2";     shift 2 ;;
    --timezone)   [ $# -ge 2 ] || error_exit "--timezone requires a value"; TIMEZONE="$2"; shift 2 ;;
    --help|-h)    print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
[ -n "$COMMAND" ] || { print_usage; exit 1; }
require_param "config (--config)" "$CONFIG"
[ -f "$CONFIG" ] || error_exit "Config file not found: $CONFIG"
jq -e 'type == "object"' "$CONFIG" >/dev/null 2>&1 || error_exit "Config file $CONFIG is not a JSON object"

# The site name: signalDigest.site, else the host of siteUrl.
SITE=$(jq -r '.signalDigest.site // ((.siteUrl // "") | sub("^[a-zA-Z]+://"; "") | sub("/.*$"; ""))' "$CONFIG")
[ -n "$SITE" ] || error_exit "Config needs signalDigest.site (or siteUrl) to name the site"
PROJECT=$(jq -r '.signalDigest.project // empty' "$CONFIG")
uri() { jq -rn --arg v "$1" '$v|@uri'; }

# api_call may print a one-line warning to stderr; the answer is the last line.
call() {
  local out
  out=$(api_call "$@" 2>&1) || { printf '%s\n' "$out" | tail -n 1; return 1; }
  printf '%s\n' "$out" | tail -n 1
}

case "$COMMAND" in
  collect)
    command -v python3 >/dev/null 2>&1 || error_exit "python3 (>= 3.8) is required"
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    ARGS=(collect --config "$CONFIG")
    [ -n "$DAYS" ] && ARGS+=(--days "$DAYS")
    # History: what the owner already chose Do / Skip on for this site.
    if HISTORY=$(call GET "/signal-digests/history?site=$(uri "$SITE")"); then
      printf '%s' "$HISTORY" > "$WORK/history.json"
      ARGS+=(--history "$WORK/history.json")
    else
      echo "{\"warning\":\"could not read the site history from Crewly; already-decided actions are not filtered out\"}" >&2
    fi
    # Experiment cards (#986): drafts their query / page already covers are dropped.
    if EXPERIMENTS=$(call GET "/experiments"); then
      printf '%s' "$EXPERIMENTS" > "$WORK/experiments.json"
      ARGS+=(--experiments "$WORK/experiments.json")
    else
      echo "{\"warning\":\"could not read the experiment cards from Crewly; drafts they cover are not filtered out\"}" >&2
    fi
    # Inbox: the site's inbound requests (signalDigest.inbox.query), via Gmail.
    INBOX_QUERY=$(jq -r '.signalDigest.inbox.query // empty' "$CONFIG")
    if [ -n "$INBOX_QUERY" ]; then
      INBOX_ACCOUNT=$(jq -r '.signalDigest.inbox.account // empty' "$CONFIG")
      INBOX_MAX=$(jq -r '.signalDigest.inbox.max // 20' "$CONFIG")
      [ -n "$INBOX_ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$INBOX_ACCOUNT"
      if INBOX=$(call GET "/google/gmail/search?q=$(uri "$INBOX_QUERY")&max=$(uri "$INBOX_MAX")"); then
        printf '%s' "$INBOX" | jq -c '{query: .data.query, count: .data.count, messages: [.data.messages[]? | {from, subject, date, snippet}]}' > "$WORK/inbox.json"
      else
        printf '%s' "$INBOX" | jq -c '{success: false, reason: (.details.error // .error // "unknown"), message: (.details.message // .message // "")}' > "$WORK/inbox.json" 2>/dev/null \
          || jq -n '{success: false, reason: "unreadable answer"}' > "$WORK/inbox.json"
      fi
      ARGS+=(--inbox "$WORK/inbox.json")
    fi
    python3 "$SCRIPT_DIR/signal_digest.py" "${ARGS[@]}"
    ;;

  propose)
    require_param "actions (--actions)" "$ACTIONS"
    if [ -f "$ACTIONS" ]; then ACTIONS_JSON=$(cat "$ACTIONS"); else ACTIONS_JSON="$ACTIONS"; fi
    ITEMS=$(printf '%s' "$ACTIONS_JSON" | jq -c 'if type == "array" then . elif type == "object" and (.items | type) == "array" then .items elif type == "object" and (.actions | type) == "array" then .actions else error("expected an array of actions") end' 2>/dev/null) \
      || error_exit "--actions must be a JSON array of actions (or {\"items\": [...]}), as a file or inline"
    # The absolute config lets a Do create the action's experiment card (#986).
    CONFIG_ABS="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
    BODY=$(jq -cn --arg site "$SITE" --arg project "$PROJECT" --arg config "$CONFIG_ABS" --argjson items "$ITEMS" \
      '{site: $site, config: $config, items: [$items[] | {key, source, signal, proposal, expectedEffect, effort}
          + (if .metric then {metric} else {} end) + (if .experiment then {experiment} else {} end)]}
        + (if $project != "" then {project: $project} else {} end)')
    if ! RESPONSE=$(call POST "/signal-digests" "$BODY"); then
      printf '%s' "$RESPONSE" | jq -c '{success: false, error: (.details.error // .error // .details // "unknown")}' 2>/dev/null || jq -n --arg r "$RESPONSE" '{success: false, error: $r}'
      exit 1
    fi
    printf '%s' "$RESPONSE" | jq -c '{success: true, digestId: .data.id, site: .data.site, actions: (.data.items | length)}
      + (if .data.card then {card: "posted"} else {card: "not posted", postError: .data.postError} end)'
    ;;

  schedule)
    # Cron tasks are created by the orchestrator (or the owner), not by a lead:
    # print the exact create-cron call to hand over.
    [ -n "${CREWLY_SESSION_NAME:-}" ] || error_exit "CREWLY_SESSION_NAME is not set: run this from your agent session"
    TEAM_ID=$(resolve_team_id) || error_exit "Could not find the team of ${CREWLY_SESSION_NAME}"
    CONFIG_ABS="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
    TASK="Daily signal digest for ${SITE}: run \`bash ${SCRIPT_DIR}/execute.sh collect --config ${CONFIG_ABS}\`, pick the 3-5 actions most worth the owner's tap (rewrite the drafts as needed), then run \`bash ${SCRIPT_DIR}/execute.sh propose --config ${CONFIG_ABS} --actions <file>\`. If no source could be examined, say so in your team channel instead."
    CRON_JSON=$(jq -cn --arg cron "${CRON:-$DEFAULT_CRON}" --arg tz "${TIMEZONE:-$DEFAULT_TIMEZONE}" --arg agent "$CREWLY_SESSION_NAME" --arg team "$TEAM_ID" --arg task "$TASK" \
      '{cronExpression: $cron, timezone: $tz, targetAgent: $agent, targetTeamId: $team, taskDescription: $task}')
    jq -cn --argjson cron "$CRON_JSON" '{success: true, createCron: $cron,
      next: "Cron tasks are created by the orchestrator: send it this createCron object and ask it to run create-cron with it (or the owner can add it under Schedules)."}'
    ;;

  *)
    error_exit "Unknown command: ${COMMAND} (collect | propose | schedule)"
    ;;
esac
