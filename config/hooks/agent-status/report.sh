#!/usr/bin/env bash
# Crewly agent-status hook — tells the backend when Claude Code is waiting on
# the user (a permission prompt or a question) and when it stops waiting.
#
# Spec: specs/2026-09-26-agent-waiting-on-human.md (#815, hook ingestion).
#
# Wired by the backend into the per-session settings file it already passes
# with `claude --settings <file>` (the control-plane guard's file) for:
#   Notification, PermissionRequest, Stop, UserPromptSubmit, PostToolUse
#
# Usage: bash report.sh            # hook JSON on stdin
#
# PRIVACY: the stdin JSON can hold tool_input, file contents, prompts and a
# transcript path, any of which may contain secrets. This script extracts
# exactly two fields — hook_event_name and notification_type — keeps them only
# if they are plain identifiers ([A-Za-z_], max 64 chars), and sends those plus
# the session name. Nothing else from stdin is sent, printed or logged.
#
# It never blocks or slows the agent: every path exits 0, and the POST has a
# 2-second ceiling. A failed POST is dropped silently (the backend's screen
# detection still covers the state).

set -u

INPUT="$(cat)"
SESSION="${CREWLY_SESSION_NAME:-}"
API_URL="${CREWLY_API_URL:-http://localhost:${WEB_PORT:-8787}}"

# No session => nothing to attribute the event to.
[ -z "$SESSION" ] && exit 0

# Pull one top-level string field out of the JSON without echoing the rest.
# jq when present; otherwise a narrow sed that only ever returns an identifier.
field() {
	local name="$1" value=""
	if command -v jq >/dev/null 2>&1; then
		value="$(printf '%s' "$INPUT" | jq -r --arg k "$name" '.[$k] // empty | select(type == "string")' 2>/dev/null)"
	else
		value="$(printf '%s' "$INPUT" | tr -d '\n' | sed -n "s/.*\"$name\"[[:space:]]*:[[:space:]]*\"\\([A-Za-z_]*\\)\".*/\\1/p")"
	fi
	# Keep only a plain identifier; anything else is discarded, not sanitised.
	if printf '%s' "$value" | grep -Eq '^[A-Za-z_]{1,64}$'; then
		printf '%s' "$value"
	fi
}

EVENT="$(field hook_event_name)"
[ -z "$EVENT" ] && exit 0
NOTIFICATION_TYPE="$(field notification_type)"

if [ -n "$NOTIFICATION_TYPE" ]; then
	BODY="{\"event\":\"$EVENT\",\"notificationType\":\"$NOTIFICATION_TYPE\"}"
else
	BODY="{\"event\":\"$EVENT\"}"
fi

ARGS=(-s -o /dev/null --max-time 2 -X POST "$API_URL/api/agent-hooks"
	-H "Content-Type: application/json"
	-H "User-Agent: crewly-agent-status-hook/1"
	-H "X-Agent-Session: $SESSION")
if [ -n "${CREWLY_AGENT_AUTHORIZATION:-}" ]; then
	ARGS+=(-H "X-Agent-Authorization: b64:$(printf '%s' "$CREWLY_AGENT_AUTHORIZATION" | base64 | tr -d '\n')")
fi

curl "${ARGS[@]}" --data "$BODY" >/dev/null 2>&1 || true
exit 0
