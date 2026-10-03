#!/usr/bin/env bash
# Crewly agent-status hook — tells the backend when Claude Code is waiting on
# the user (a permission prompt or a question) and when it stops waiting, and
# where it is in its turn (turn start/end, tool calls, subagents).
#
# Spec: specs/2026-09-26-agent-waiting-on-human.md (#815, hook ingestion);
# specs/2026-10-02-restart-busy-and-resume.md (runtime turn state).
#
# Wired by the backend into the per-session settings file it already passes
# with `claude --settings <file>` (the control-plane guard's file) for:
#   Notification, PermissionRequest, Stop, UserPromptSubmit, PreToolUse,
#   PostToolUse, SubagentStart, SubagentStop, SessionStart
#
# Usage: bash report.sh            # hook JSON on stdin
#
# PRIVACY: the stdin JSON can hold tool_input, file contents, prompts and a
# transcript path, any of which may contain secrets. This script extracts
# exactly five TOP-LEVEL fields — hook_event_name, notification_type and
# source (kept only as plain identifiers, [A-Za-z_], max 64 chars), tool_use_id and
# agent_id (kept only as [A-Za-z0-9_-], max 128 chars) — and sends those plus
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

# Pull one TOP-LEVEL string field out of the JSON without echoing the rest.
# Only a real JSON parser can tell a top-level key from the same key nested in
# tool_input (a regex cannot: `"hook_event_name":"Stop"` inside a command would
# spoof the event). So: jq, else node's JSON.parse, else nothing — the event is
# dropped and the backend's screen detection still covers the state.
NAME_PATTERN='^[A-Za-z_]{1,64}$'
field() {
	local name="$1" pattern="${2:-$NAME_PATTERN}" value=""
	if command -v jq >/dev/null 2>&1; then
		value="$(printf '%s' "$INPUT" | jq -r --arg k "$name" 'if type == "object" then (.[$k] // empty | select(type == "string")) else empty end' 2>/dev/null)"
	elif command -v node >/dev/null 2>&1; then
		value="$(printf '%s' "$INPUT" | node -e '
			let s = "";
			process.stdin.on("data", (c) => { s += c; });
			process.stdin.on("end", () => {
				try {
					const o = JSON.parse(s);
					const v = o && typeof o === "object" && !Array.isArray(o) ? o[process.argv[1]] : undefined;
					if (typeof v === "string") process.stdout.write(v);
				} catch { /* not JSON: send nothing */ }
			});' "$name" 2>/dev/null)"
	fi
	# Keep only a plain identifier; anything else is discarded, not sanitised.
	if printf '%s' "$value" | grep -Eq "$pattern"; then
		printf '%s' "$value"
	fi
}

EVENT="$(field hook_event_name)"
[ -z "$EVENT" ] && exit 0
NOTIFICATION_TYPE="$(field notification_type)"
ID_PATTERN='^[A-Za-z0-9_-]{1,128}$'
TOOL_USE_ID=""
AGENT_ID=""
SOURCE=""
case "$EVENT" in
	PreToolUse|PostToolUse) TOOL_USE_ID="$(field tool_use_id "$ID_PATTERN")" ;;
	SubagentStart|SubagentStop) AGENT_ID="$(field agent_id "$ID_PATTERN")" ;;
	SessionStart) SOURCE="$(field source)" ;;
esac

BODY="{\"event\":\"$EVENT\""
[ -n "$NOTIFICATION_TYPE" ] && BODY="$BODY,\"notificationType\":\"$NOTIFICATION_TYPE\""
[ -n "$TOOL_USE_ID" ] && BODY="$BODY,\"toolUseId\":\"$TOOL_USE_ID\""
[ -n "$AGENT_ID" ] && BODY="$BODY,\"agentId\":\"$AGENT_ID\""
[ -n "$SOURCE" ] && BODY="$BODY,\"source\":\"$SOURCE\""
BODY="$BODY}"

ARGS=(-s -o /dev/null --max-time 2 -X POST "$API_URL/api/agent-hooks"
	-H "Content-Type: application/json"
	-H "User-Agent: crewly-agent-status-hook/1"
	-H "X-Agent-Session: $SESSION")
# The agent badge (#999): the credential behind X-Agent-Session.
if [ -n "${CREWLY_AGENT_BADGE:-}" ]; then
	ARGS+=(-H "X-Agent-Badge: $CREWLY_AGENT_BADGE")
fi
if [ -n "${CREWLY_AGENT_AUTHORIZATION:-}" ]; then
	ARGS+=(-H "X-Agent-Authorization: b64:$(printf '%s' "$CREWLY_AGENT_AUTHORIZATION" | base64 | tr -d '\n')")
fi

curl "${ARGS[@]}" --data "$BODY" >/dev/null 2>&1 || true
exit 0
