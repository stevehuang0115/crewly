#!/bin/bash
# =============================================================================
# publish-app — publish a small web app to https://apps.crewlyai.com/<appId>
#
# Backed by POST /api/apps/publish (and /api/apps/:id/rollback, /versions,
# GET /api/apps). The backend calls Crewly Cloud with its own login; this
# script only reads the bundle files (as you, so the credential guard
# applies) and sends their contents. specs/2026-10-04-crewly-apps-p2.md
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --dir ./my-app [--name "Groceries"] [--entry index.html] [--note "what changed"] [--notify]
  bash execute.sh --html ./timer.html --name "Timer" [--notify]
  bash execute.sh --app <appId> --dir ./my-app          # republish to a known app explicitly
  bash execute.sh --app <appId> --rollback <version>    # make an earlier version current
  bash execute.sh --app <appId> --versions              # list versions
  bash execute.sh --list                                # apps published from this machine

Options:
  --dir        Directory to publish (index.html at its root unless --entry)
  --html       A single HTML file (published as index.html)
  --name       App name (new app; renames an existing one)
  --app        Publish to / act on this appId instead of the one recorded for you
  --entry      Entry file inside the bundle (default index.html)
  --note       Short note stored with the version
  --notify     Post "📱 <name> · Open app" to the owner where you talk with them
  --rollback   Version number to make current (needs --app)
  --versions   List versions (needs --app)
  --list       List apps published from this machine
  --help | -h  Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, reason: (.details.error // .error // "unknown"), message: (.details.message // .details // ""), hint: (.details.hint // "")}' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

# api_call may print a one-line warning to stderr; the answer is the last line.
call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s\n' "$out" | tail -n 1)"; }
  printf '%s\n' "$out" | tail -n 1
}

DIR=""; FILE=""; NAME=""; APP=""; ENTRY=""; NOTE=""; NOTIFY=false; ROLLBACK=""; VERSIONS=false; LIST=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)      [ $# -ge 2 ] || error_exit "--dir requires a value";      DIR="$2";      shift 2 ;;
    --html)     [ $# -ge 2 ] || error_exit "--html requires a value";     FILE="$2";     shift 2 ;;
    --name)     [ $# -ge 2 ] || error_exit "--name requires a value";     NAME="$2";     shift 2 ;;
    --app)      [ $# -ge 2 ] || error_exit "--app requires a value";      APP="$2";      shift 2 ;;
    --entry)    [ $# -ge 2 ] || error_exit "--entry requires a value";    ENTRY="$2";    shift 2 ;;
    --note)     [ $# -ge 2 ] || error_exit "--note requires a value";     NOTE="$2";     shift 2 ;;
    --rollback) [ $# -ge 2 ] || error_exit "--rollback requires a value"; ROLLBACK="$2"; shift 2 ;;
    --notify)   NOTIFY=true; shift ;;
    --versions) VERSIONS=true; shift ;;
    --list)     LIST=true; shift ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if $LIST; then
  RESPONSE=$(call GET "/apps") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: true, apps: [.data[]? | select(.deleted != true) | {appId, name, url, agent: .agentSession, currentVersion, source}]}'
  exit 0
fi

if [ -n "$ROLLBACK" ] || $VERSIONS; then
  [ -n "$APP" ] || error_exit "--app is required with --rollback / --versions"
  if $VERSIONS; then
    RESPONSE=$(call GET "/apps/${APP}/versions") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, versions: [.data[]? | {version, current, note, files, totalBytes, createdAt}]}'
    exit 0
  fi
  [[ "$ROLLBACK" =~ ^[0-9]+$ ]] || error_exit "--rollback must be a version number"
  BODY=$(jq -cn --argjson v "$ROLLBACK" '{version: $v}')
  RESPONSE=$(call POST "/apps/${APP}/rollback" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: true, appId: .data.appId, url: ("https://apps.crewlyai.com/" + .data.appId), currentVersion: .data.currentVersion}'
  exit 0
fi

[ -n "$DIR" ] || [ -n "$FILE" ] || error_exit "--dir or --html is required (see --help)"
[ -z "$DIR" ] || [ -z "$FILE" ] || error_exit "use --dir or --html, not both"
command -v node >/dev/null 2>&1 || error_exit "node is required to package the app"

BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/crewly-publish-XXXXXX")"
trap 'rm -f "$BODY_FILE"' EXIT

# Package the bundle: every file under --dir except dotfiles, node_modules
# and anything under a dot-directory (.git, .env, …). Limits are Crewly
# Apps': 300 files, 5 MB per file, 25 MB per version.
PUB_DIR="$DIR" PUB_FILE="$FILE" PUB_NAME="$NAME" PUB_APP="$APP" PUB_ENTRY="$ENTRY" PUB_NOTE="$NOTE" PUB_NOTIFY="$NOTIFY" PUB_OUT="$BODY_FILE" \
node <<'NODE' || exit 1
const fs = require('fs');
const path = require('path');
const env = process.env;
const fail = (msg) => { process.stderr.write(JSON.stringify({ error: msg }) + '\n'); process.exit(1); };
const MAX_FILES = 300, MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 25 * 1024 * 1024;
const files = [];
let total = 0;
const add = (abs, rel) => {
  const size = fs.statSync(abs).size;
  if (size > MAX_FILE) fail(`${rel} is ${(size / 1048576).toFixed(1)} MB; a file can be at most 5 MB`);
  total += size;
  if (total > MAX_TOTAL) fail('the app is larger than 25 MB');
  if (files.length >= MAX_FILES) fail('the app has more than 300 files');
  files.push({ path: rel, contentBase64: fs.readFileSync(abs).toString('base64') });
};
let source;
if (env.PUB_FILE) {
  const abs = path.resolve(env.PUB_FILE);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`file not found: ${env.PUB_FILE}`);
  if (!/\.html?$/i.test(abs)) fail('--html must be an .html file; use --dir for a multi-file app');
  source = fs.realpathSync(abs);
  add(abs, 'index.html');
} else {
  const root = path.resolve(env.PUB_DIR);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`directory not found: ${env.PUB_DIR}`);
  source = fs.realpathSync(root);
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) add(abs, rel);
    }
  };
  walk(root, '');
  const entry = env.PUB_ENTRY || 'index.html';
  if (!files.some((f) => f.path === entry)) fail(`${entry} is not in ${env.PUB_DIR} (set --entry)`);
}
if (files.length === 0) fail('nothing to publish');
const body = { files, source };
if (env.PUB_NAME) body.name = env.PUB_NAME;
if (env.PUB_APP) body.appId = env.PUB_APP;
if (env.PUB_ENTRY && !env.PUB_FILE) body.entry = env.PUB_ENTRY;
if (env.PUB_NOTE) body.note = env.PUB_NOTE;
if (env.PUB_NOTIFY === 'true') body.notify = true;
fs.writeFileSync(env.PUB_OUT, JSON.stringify(body));
NODE

AUTH=()
while IFS= read -r a; do AUTH+=("$a"); done < <(agent_auth_curl_args)
[ -n "${CREWLY_SESSION_NAME:-}" ] && AUTH+=(-H "X-Agent-Pid: $$")
OUT=$(curl -s -w '\n%{http_code}' -X POST -H "Content-Type: application/json" ${AUTH[@]+"${AUTH[@]}"} \
  --data-binary "@${BODY_FILE}" "${CREWLY_API_URL}/api/apps/publish") || error_exit "could not reach the Crewly backend at ${CREWLY_API_URL}"
CODE=$(printf '%s\n' "$OUT" | tail -n 1)
RESP=$(printf '%s\n' "$OUT" | sed '$d')
if [ "$CODE" -ge 200 ] 2>/dev/null && [ "$CODE" -lt 300 ] 2>/dev/null; then
  printf '%s' "$RESP" | jq -c '{success: true, appId: .data.appId, name: .data.name, url: .data.url, version: .data.version, created: .data.created, notified: .data.notified} + (if .data.notifyError then {notifyError: .data.notifyError} else {} end)'
else
  printf '%s' "$RESP" | jq -c --arg code "$CODE" '{success: false, status: ($code|tonumber), reason: (.error // "unknown"), message: (.message // ""), hint: (.hint // "")}' 2>/dev/null \
    || jq -cn --arg code "$CODE" '{success: false, status: ($code|tonumber? // 0), reason: "http_error"}'
  exit 1
fi
