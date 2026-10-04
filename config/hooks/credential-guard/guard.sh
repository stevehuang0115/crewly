#!/usr/bin/env bash
# Crewly credential guard — a pre-tool hook that refuses an agent's tool call
# when it touches Crewly's own credentials.
#
# Spec: specs/2026-10-04-agent-credential-isolation.md (layer 2).
#
# Usage (wired by the backend; the hook JSON arrives on stdin):
#   bash guard.sh <format> [<paths-file>]
#     format:     claude | codex | gemini | antigravity
#     paths-file: written by the backend at launch; defaults to
#                 $CREWLY_CREDENTIAL_GUARD_PATHS
#
# Paths-file lines (tab-separated):  <kind> <rule-id> <string>
#   home  -        <CREWLY_HOME>
#   abs   <id>     an absolute credential path (file or directory)
#   tail  <id>     the same path from the home's parent: `.crewly/cloud`
#   rel   <id>     the same path relative to CREWLY_HOME: `cloud`
#                  (matched only when the call's cwd is inside CREWLY_HOME)
#
# What it inspects: every string in the tool's arguments (a shell command, a
# file path, a glob, a search path). It expands ~, $HOME, ${HOME},
# $CREWLY_HOME and ${CREWLY_HOME}, drops quotes and backslashes, then looks
# for a credential path followed by a path boundary. It also refuses
# `security find-generic-password|find-internet-password|dump-keychain|export`
# naming Crewly's keychain items (`crewly:`), and any `dump-keychain`.
#
# Deny contract:
#   claude, codex, gemini  exit 2, reason on stderr (fed back to the model)
#   antigravity            stdout {"decision":"deny","reason":"..."}, exit 0
#                          (agy treats `{}` and a non-zero exit as deny, so
#                          an allowed call prints NOTHING and exits 0)
#
# Only agent sessions are judged: with no CREWLY_SESSION_NAME in the
# environment (the owner's own `agy`, which shares agy's global hooks file)
# every call is allowed.
#
# Coverage limits, stated so a clean result is not over-read:
#   - a path built at runtime ($(echo …), base64, globs like ~/.cr*ly,
#     variables other than the ones expanded above) is NOT seen
#   - a script file the agent writes first and then runs is NOT seen
#   - calls to the loopback API are NOT this hook's business (owner-only routes)
#   - it is a speed bump, not a boundary: the agent runs as the same OS user

set -u

FORMAT="${1:-claude}"
PATHS_FILE="${2:-${CREWLY_CREDENTIAL_GUARD_PATHS:-}}"
PREFIX="credential-guard:"
REASON_TAIL="Crewly credentials are not available to agents. Use the connector skills instead (docs-read, drive-read, sheets-read, gmail-search, ...) — they act for you without handing out a token. If a skill cannot do what you need, say so to the owner instead of working around it."

INPUT="$(cat)"

allow() {
	# Nothing on stdout: agy reads `{}` as deny.
	[ -n "${1:-}" ] && echo "$PREFIX $1" >&2
	exit 0
}

# Owner's own runtime (no agent session): never judged.
SESSION="${CREWLY_SESSION_NAME:-}"
[ -z "$SESSION" ] && exit 0

# ---- pull every string out of the tool arguments --------------------------
STRINGS=""
CWD=""
if command -v jq >/dev/null 2>&1; then
	STRINGS="$(printf '%s' "$INPUT" | jq -r '[.tool_input, .toolCall.args, .tool_args] | map(select(. != null)) | [.[] | .. | strings] | .[]' 2>/dev/null)"
	CWD="$(printf '%s' "$INPUT" | jq -r '(.cwd // .toolCall.args.Cwd // ((.workspacePaths // [])[0]) // empty) | strings' 2>/dev/null)"
elif command -v node >/dev/null 2>&1; then
	STRINGS="$(printf '%s' "$INPUT" | node -e '
		let s = "";
		process.stdin.on("data", (c) => { s += c; });
		process.stdin.on("end", () => {
			try {
				const o = JSON.parse(s);
				const out = [];
				const walk = (v) => { if (typeof v === "string") out.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
				[o.tool_input, o.toolCall && o.toolCall.args, o.tool_args].forEach(walk);
				process.stdout.write(out.join("\n"));
			} catch { /* not JSON */ }
		});' 2>/dev/null)"
	CWD="$(printf '%s' "$INPUT" | node -e '
		let s = "";
		process.stdin.on("data", (c) => { s += c; });
		process.stdin.on("end", () => {
			try {
				const o = JSON.parse(s);
				const c = o.cwd || (o.toolCall && o.toolCall.args && o.toolCall.args.Cwd) || (o.workspacePaths || [])[0];
				if (typeof c === "string") process.stdout.write(c);
			} catch { /* not JSON */ }
		});' 2>/dev/null)"
else
	allow "neither jq nor node found — nothing checked"
fi

[ -z "$STRINGS" ] && exit 0

# ---- load the credential paths ---------------------------------------------
if [ -z "$PATHS_FILE" ] || [ ! -f "$PATHS_FILE" ]; then
	echo "$PREFIX NO PATHS CHECKED — paths file missing (${PATHS_FILE:-<none>})" >&2
	[ "$FORMAT" = "antigravity" ] && exit 0
	exit 1
fi

CREWLY_HOME_DIR=""
KINDS=()
IDS=()
PATTERNS=()
TAB="$(printf '\t')"
while IFS="$TAB" read -r kind id value || [ -n "$kind" ]; do
	case "$kind" in
		home) CREWLY_HOME_DIR="$value" ;;
		abs|tail|rel) KINDS+=("$kind"); IDS+=("$id"); PATTERNS+=("$value") ;;
	esac
done < "$PATHS_FILE"

# ---- normalise --------------------------------------------------------------
HOME_DIR="${HOME:-}"
NORM="$STRINGS"
if [ -n "$CREWLY_HOME_DIR" ]; then
	NORM="${NORM//\$\{CREWLY_HOME\}/$CREWLY_HOME_DIR}"
	NORM="${NORM//\$CREWLY_HOME/$CREWLY_HOME_DIR}"
fi
if [ -n "$HOME_DIR" ]; then
	NORM="${NORM//\$\{HOME\}/$HOME_DIR}"
	NORM="${NORM//\$HOME/$HOME_DIR}"
	NORM="${NORM//\~\//$HOME_DIR/}"
fi
NORM="${NORM//\"/}"
NORM="${NORM//\'/}"
NORM="${NORM//\\/}"
# Collapse // and /./ so `~/.crewly//cloud` and `~/.crewly/./api-token` match.
NORM="$(printf '%s' "$NORM" | sed -e 's#//*#/#g' -e 's#/\./#/#g')"

CWD_IN_HOME=0
if [ -n "$CREWLY_HOME_DIR" ] && [ -n "$CWD" ]; then
	case "${CWD%/}/" in "${CREWLY_HOME_DIR%/}/"*) CWD_IN_HOME=1 ;; esac
fi
# A `cd` into the Crewly home inside the command counts the same.
case "$NORM" in *"cd ${CREWLY_HOME_DIR%/}"*) [ -n "$CREWLY_HOME_DIR" ] && CWD_IN_HOME=1 ;; esac

# Escape a literal for grep -E.
ere_escape() {
	printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|/]/\\&/g'
}

MATCH_ID=""
i=0
while [ "$i" -lt "${#PATTERNS[@]}" ]; do
	kind="${KINDS[$i]}"
	pat="${PATTERNS[$i]}"
	if [ "$kind" = "rel" ] && [ "$CWD_IN_HOME" -ne 1 ]; then
		i=$((i+1)); continue
	fi
	esc="$(ere_escape "$pat")"
	if [ "$kind" = "rel" ]; then
		# A bare relative name must start a word: `cat cloud/config.json`, `./api-token`.
		re="(^|[[:space:]=:<>(])(\./)?${esc}([^A-Za-z0-9._-]|$)"
	else
		re="${esc}([^A-Za-z0-9._-]|$)"
	fi
	if printf '%s\n' "$NORM" | grep -Eq -- "$re"; then
		MATCH_ID="${IDS[$i]}"
		break
	fi
	i=$((i+1))
done

if [ -z "$MATCH_ID" ]; then
	LOWER="$(printf '%s' "$NORM" | tr '[:upper:]' '[:lower:]')"
	# `security` as a command word (also /usr/bin/security, or fed on stdin).
	if printf '%s\n' "$LOWER" | grep -Eq '(^|[^a-z0-9_-])security([[:space:]]|$)'; then
		if printf '%s\n' "$LOWER" | grep -Eq 'dump-keychain'; then
			MATCH_ID="keychain"
		elif printf '%s\n' "$LOWER" | grep -Eq 'crewly' && printf '%s\n' "$LOWER" | grep -Eq \
			'(find-generic-password|find-internet-password|security([[:space:]]+-[a-z]+)*[[:space:]]+export|security[[:space:]]+-i([[:space:]]|$)|\|[[:space:]]*(/usr/bin/)?security([[:space:]]|$))'; then
			MATCH_ID="keychain"
		fi
	fi
fi

[ -z "$MATCH_ID" ] && exit 0

REASON="Blocked: this touches Crewly's own credentials (${MATCH_ID}). ${REASON_TAIL}"

# ---- tell the backend (warning in its log; the owner hears once a day) ------
API_URL="${CREWLY_API_URL:-http://localhost:${WEB_PORT:-8787}}"
if command -v curl >/dev/null 2>&1; then
	RULE="$(printf '%s' "$MATCH_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)"
	CURL_ARGS=(-s -o /dev/null --max-time 2 -X POST "$API_URL/api/agent-hooks"
		-H "Content-Type: application/json"
		-H "User-Agent: crewly-credential-guard/1"
		-H "X-Agent-Session: $SESSION")
	if [ -n "${CREWLY_AGENT_BADGE:-}" ]; then
		CURL_ARGS+=(-H "X-Agent-Badge: $CREWLY_AGENT_BADGE")
	fi
	curl "${CURL_ARGS[@]}" --data "{\"event\":\"CredentialAccessBlocked\",\"rule\":\"$RULE\",\"runtime\":\"$(printf '%s' "$FORMAT" | tr -cd 'a-z')\"}" >/dev/null 2>&1 || true
fi

if [ "$FORMAT" = "antigravity" ]; then
	ESCAPED="$(printf '%s' "$REASON" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
	printf '{"decision":"deny","reason":"%s"}\n' "$ESCAPED"
	exit 0
fi

echo "$REASON" >&2
exit 2
