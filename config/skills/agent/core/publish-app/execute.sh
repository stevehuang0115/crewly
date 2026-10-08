#!/bin/bash
# =============================================================================
# publish-app — publish a small web app to https://apps.crewlyai.com/<appId>
#
# Backed by POST /api/apps/publish (and /api/apps/:id/rollback, /versions,
# GET /api/apps). The backend calls Crewly Cloud with its own login; this
# script only reads the bundle files (as you, so the credential guard
# applies) and sends their contents. specs/2026-10-04-crewly-apps-p2.md
#
# Publishing or rolling back a PUBLIC app takes it private until the owner
# stays public (since 2026-10-04 a new version no longer pauses it).
#
# P3 (specs/2026-10-04-crewly-apps-p3.md): the card carries a signed
# one-tap link the backend mints and posts to the owner DM only — this
# script never sees it. --share / --links / --revoke-link(s) manage those
# links; --public asks the OWNER to make the app public (only the owner can,
# in the app); --private / --cancel-public undo.
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
  bash execute.sh --app <appId> --transfer-to <session> # hand the app to another agent / team
  bash execute.sh --app <appId> --owner 'channel:#daily-brief'   # who gets the owner's comments (also with a publish)
  bash execute.sh --list                                # apps published from this machine
  bash execute.sh --app <appId> --share [--ttl-days 7]  # fresh one-tap link card to the owner (no publish)
  bash execute.sh --app <appId> --links                 # open-links of the app (no secrets)
  bash execute.sh --app <appId> --revoke-link <linkId>  # revoke one link
  bash execute.sh --app <appId> --revoke-links          # revoke every link
  bash execute.sh --app <appId> --public --public-read items,stats --public-submit votes [--public-note "why"]
                                                        # ASK the owner to make it public (they approve in the app)
  bash execute.sh --dir ./my-app --public --public-read items   # publish and ask in one go
  bash execute.sh --app <appId> --cancel-public         # withdraw a pending request
  bash execute.sh --app <appId> --private               # private again (instant)
  bash execute.sh --app <appId> --refresh-thumbnail     # re-take the portal thumbnail now (publishing also does it)
  bash execute.sh --app <appId> --as-template --description "what it does" [--tags a,b] [--category family] [--author "Steve"] [--sample-data sample.json]
                                                        # ASK the owner to publish it as a Marketplace template (a card; no data is included)
  bash execute.sh --my-templates                        # this account's templates
  bash execute.sh --unlist-template <templateId>        # take one off the Marketplace (instant)

Options:
  --dir        Directory to publish (index.html at its root unless --entry)
  --html       A single HTML file (published as index.html)
  --name       App name (new app; renames an existing one)
  --app        Publish to / act on this appId instead of the one recorded for you
  --entry      Entry file inside the bundle (default index.html)
  --note       Short note stored with the version
  --notify     Post "📱 <name> · Open app" to the owner (one-tap signed link in your DM with them)
  --share      Post the card again with a fresh link, without publishing (needs --app)
  --ttl-days   Lifetime of the shared link, 1-30 days (default 7)
  --links      List the app's open-links (needs --app)
  --revoke-link <linkId> / --revoke-links   Revoke one / all open-links (needs --app)
  --public     Ask the owner to make the app public; name collections with:
  --public-read    Collections anonymous visitors may read (comma-separated, max 20)
  --public-submit  Collections anonymous visitors may add to (append-only, max 20)
  --public-note    Why, shown to the owner
  --cancel-public  Withdraw a pending public request (needs --app)
  --private    Make the app private again, instantly (needs --app)
  --refresh-thumbnail  Re-capture the app's thumbnail for the owner's portal list (needs --app; needs Chrome on this machine)
  --as-template  Ask the owner to publish the app (its current version, code only) as a public Marketplace template (needs --app, --description)
  --description  What the app does, for the Marketplace (with --as-template; at most 500 characters)
  --category     productivity | tracker | checklist | forms | education | family | health | finance | events | games | business | other
  --tags         Comma-separated words (at most 8)
  --author       The owner's display name for "by …" (the owner can still choose anonymous on the card)
  --sample-data  JSON file {"<collection>": [ {…}, … ]} shown only in the preview (≤ 10 collections × 20 docs, 64 KB; no real data)
  --my-templates      List this account's templates
  --unlist-template   Take a template off the Marketplace (apps made from it are not affected)
  --rollback   Version number to make current (needs --app)
  --versions   List versions (needs --app)
  --transfer-to  Hand the app to another agent (its session name; it must be on a team on this machine).
  --owner      Who owns the app's comments: channel:#<name>, team:<name>, agent:<name> or default (the publishing agent).
               With a publish it is set after the publish; alone it needs --app. Only the app's owner agents may change it.
                 Allowed for the app's publisher, the lead of its team, the orchestrator or the owner.
                 The new publisher publishes with --app <appId> --dir <its directory>; the old team loses access.
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

DIR=""; FILE=""; NAME=""; APP=""; ENTRY=""; NOTE=""; NOTIFY=false; ROLLBACK=""; TRANSFER_TO=""; VERSIONS=false; LIST=false
SHARE=false; TTL_DAYS=""; LINKS=false; REVOKE_LINK=""; REVOKE_LINKS=false; OWNER_SPEC=""
PUBLIC=false; PUBLIC_READ=""; PUBLIC_SUBMIT=""; PUBLIC_NOTE=""; CANCEL_PUBLIC=false; PRIVATE=false; REFRESH_THUMB=false
AS_TEMPLATE=false; TPL_DESCRIPTION=""; TPL_CATEGORY=""; TPL_TAGS=""; TPL_AUTHOR=""; TPL_SAMPLE=""; UNLIST_TEMPLATE=""; MY_TEMPLATES=false
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
    --share)    SHARE=true; shift ;;
    --ttl-days) [ $# -ge 2 ] || error_exit "--ttl-days requires a value"; TTL_DAYS="$2"; shift 2 ;;
    --links)    LINKS=true; shift ;;
    --revoke-link)  [ $# -ge 2 ] || error_exit "--revoke-link requires a link id"; REVOKE_LINK="$2"; shift 2 ;;
    --revoke-links) REVOKE_LINKS=true; shift ;;
    --public)   PUBLIC=true; shift ;;
    --public-read)   [ $# -ge 2 ] || error_exit "--public-read requires collection names"; PUBLIC_READ="$2"; PUBLIC=true; shift 2 ;;
    --public-submit) [ $# -ge 2 ] || error_exit "--public-submit requires collection names"; PUBLIC_SUBMIT="$2"; PUBLIC=true; shift 2 ;;
    --public-note)   [ $# -ge 2 ] || error_exit "--public-note requires a value"; PUBLIC_NOTE="$2"; shift 2 ;;
    --cancel-public) CANCEL_PUBLIC=true; shift ;;
    --private)  PRIVATE=true; shift ;;
    --refresh-thumbnail) REFRESH_THUMB=true; shift ;;
    --versions) VERSIONS=true; shift ;;
    --transfer-to) [ $# -ge 2 ] || error_exit "--transfer-to requires a session name"; TRANSFER_TO="$2"; shift 2 ;;
    --owner)    [ $# -ge 2 ] || error_exit "--owner requires channel:#<name>, team:<name>, agent:<name> or default"; OWNER_SPEC="$2"; shift 2 ;;
    --list)     LIST=true; shift ;;
    --as-template)   AS_TEMPLATE=true; shift ;;
    --description)   [ $# -ge 2 ] || error_exit "--description requires a value"; TPL_DESCRIPTION="$2"; shift 2 ;;
    --category)      [ $# -ge 2 ] || error_exit "--category requires a value"; TPL_CATEGORY="$2"; shift 2 ;;
    --tags)          [ $# -ge 2 ] || error_exit "--tags requires a value"; TPL_TAGS="$2"; shift 2 ;;
    --author)        [ $# -ge 2 ] || error_exit "--author requires a value"; TPL_AUTHOR="$2"; shift 2 ;;
    --sample-data)   [ $# -ge 2 ] || error_exit "--sample-data requires a JSON file"; TPL_SAMPLE="$2"; shift 2 ;;
    --unlist-template) [ $# -ge 2 ] || error_exit "--unlist-template requires a template id"; UNLIST_TEMPLATE="$2"; shift 2 ;;
    --my-templates)  MY_TEMPLATES=true; shift ;;
    --help|-h)  print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

# --- Marketplace templates (specs/2026-10-08-app-templates.md) ---------------
# --as-template asks the OWNER (a decision card with a preview link) to publish
# the app as a public template; Crewly Cloud first scans it for secrets and
# personal data and refuses with what it found. No agent can list a template.
if $AS_TEMPLATE || [ -n "$UNLIST_TEMPLATE" ] || $MY_TEMPLATES; then
  [ -z "$DIR" ] && [ -z "$FILE" ] || error_exit "--as-template, --unlist-template and --my-templates act on a published app (--app <id>); publish it first, then run them"
  if $MY_TEMPLATES; then
    RESPONSE=$(call GET "/apps/templates/mine") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, templates: [.data.templates[]? | {templateId, name, status, installs, authorName,
      listedVersion: (.listed.version // null), draftVersion: (.draft.version // null)}]}'
    exit 0
  fi
  if [ -n "$UNLIST_TEMPLATE" ]; then
    [[ "$UNLIST_TEMPLATE" =~ ^tpl-[a-km-np-z2-9]{10}$ ]] || error_exit "--unlist-template takes a template id (tpl-…, see --my-templates)"
    RESPONSE=$(call POST "/apps/templates/${UNLIST_TEMPLATE}/unlist") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, templateId: .data.templateId, status: .data.status}'
    exit 0
  fi
  [ -n "$APP" ] || error_exit "--as-template needs --app <appId> (see --list)"
  [ -n "$TPL_DESCRIPTION" ] || error_exit "--as-template needs --description: one or two sentences on what the app does, for people browsing the Marketplace"
  SAMPLE='null'
  if [ -n "$TPL_SAMPLE" ]; then
    [ -f "$TPL_SAMPLE" ] || error_exit "--sample-data file not found: $TPL_SAMPLE"
    SAMPLE=$(jq -c 'if type == "object" then . else error("not an object") end' "$TPL_SAMPLE" 2>/dev/null) || error_exit "--sample-data must be a JSON object: {\"<collection>\": [ {…}, … ]}"
  fi
  BODY=$(jq -cn --arg d "$TPL_DESCRIPTION" --arg n "$NAME" --arg c "$TPL_CATEGORY" --arg t "$TPL_TAGS" --arg a "$TPL_AUTHOR" --argjson s "$SAMPLE" \
    '{description: $d} + (if $n != "" then {name: $n} else {} end) + (if $c != "" then {category: $c} else {} end)
      + (if $t != "" then {tags: $t} else {} end) + (if $a != "" then {author: $a} else {} end) + (if $s != null then {sampleData: $s} else {} end)')
  AUTH=()
  while IFS= read -r a; do AUTH+=("$a"); done < <(agent_auth_curl_args)
  [ -n "${CREWLY_SESSION_NAME:-}" ] && AUTH+=(-H "X-Agent-Pid: $$")
  OUT=$(curl -s -w '\n%{http_code}' -X POST -H "Content-Type: application/json" ${AUTH[@]+"${AUTH[@]}"} \
    --data-binary "$BODY" "${CREWLY_API_URL}/api/apps/${APP}/template-request") || error_exit "could not reach the Crewly backend at ${CREWLY_API_URL}"
  CODE=$(printf '%s\n' "$OUT" | tail -n 1)
  RESP=$(printf '%s\n' "$OUT" | sed '$d')
  if [ "$CODE" -ge 200 ] 2>/dev/null && [ "$CODE" -lt 300 ] 2>/dev/null; then
    printf '%s' "$RESP" | jq -c '.data | {success: true, requested: true, appId: "'"$APP"'", templateId, version, decisionId, previewUrl, listedVersion, files, excluded, message}'
  else
    # A refused safety scan lists what was found and where (masked), so it can be fixed.
    printf '%s' "$RESP" | jq -c --arg code "$CODE" '{success: false, status: ($code|tonumber), reason: (.error // "unknown"), message: (.message // ""), hint: (.hint // "")}
      + (if .findings then {findings: [.findings[] | {path, line, kind, what, excerpt}]} else {} end)' 2>/dev/null \
      || jq -cn --arg code "$CODE" '{success: false, status: ($code|tonumber? // 0), reason: "http_error"}'
    exit 1
  fi
  exit 0
fi

if $LIST; then
  RESPONSE=$(call GET "/apps") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: true, apps: [.data[]? | select(.deleted != true) | {appId, name, url, agent: .agentSession, currentVersion, source}]}'
  exit 0
fi

# Comma-separated collection names → a JSON array, checked like the backend
# does (P2 collection pattern, at most 20).
collections_json() {
  local flag="$1" list="$2" out="[]" n=0 name
  local IFS=','
  for name in $list; do
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -n "$name" ] || continue
    [[ "$name" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || error_exit "$flag: \"$name\" is not a collection name (1-64 of A-Z a-z 0-9 _ -)"
    out=$(printf '%s' "$out" | jq -c --arg n "$name" 'if index($n) then . else . + [$n] end')
    n=$(printf '%s' "$out" | jq 'length')
    [ "$n" -le 20 ] || error_exit "$flag can name at most 20 collections"
  done
  printf '%s' "$out"
}

PUBLIC_BODY=""
if $PUBLIC; then
  [ -n "$PUBLIC_READ" ] || [ -n "$PUBLIC_SUBMIT" ] || error_exit "--public needs --public-read and/or --public-submit (the collections visitors may read / add to)"
  PUBLIC_BODY=$(jq -cn --argjson r "$(collections_json --public-read "$PUBLIC_READ")" --argjson s "$(collections_json --public-submit "$PUBLIC_SUBMIT")" --arg note "$PUBLIC_NOTE" \
    '{publicRead: $r, publicSubmit: $s} + (if $note != "" then {note: $note} else {} end)')
fi
if [ -n "$TTL_DAYS" ]; then
  [[ "$TTL_DAYS" =~ ^[0-9]+$ ]] && [ "$TTL_DAYS" -ge 1 ] && [ "$TTL_DAYS" -le 30 ] || error_exit "--ttl-days must be 1-30"
fi

# The card fields the backend reports. Never a link: the signed URL stays
# in the owner's DM.
CARD_JQ='(if .notified != null then {notified} else {} end)
  + (if .card then {card} else {} end) + (if .cardPlace then {cardPlace} else {} end)
  + (if .linkId then {linkId} else {} end) + (if .linkExpiresAt then {linkExpiresAt} else {} end)
  + (if .notifyError then {notifyError} else {} end) + (if .linkError then {linkError} else {} end)'
PUBLIC_MSG='Requested: the owner approves it by opening the app. It stays private until they do; you cannot make it public yourself.'

if [ -n "$DIR" ] || [ -n "$FILE" ]; then
  if $LINKS || $REVOKE_LINKS || $CANCEL_PUBLIC || $PRIVATE || $REFRESH_THUMB || [ -n "$REVOKE_LINK" ]; then
    error_exit "--links, --revoke-link(s), --cancel-public and --private act on an app (--app <id>), not on a publish"
  fi
fi

if [ -z "$DIR" ] && [ -z "$FILE" ]; then
  ACTIONS=0
  for a in "$SHARE" "$LINKS" "$REVOKE_LINKS" "$PUBLIC" "$CANCEL_PUBLIC" "$PRIVATE" "$REFRESH_THUMB"; do $a && ACTIONS=$((ACTIONS+1)); done
  [ -n "$REVOKE_LINK" ] && ACTIONS=$((ACTIONS+1))
  if [ "$ACTIONS" -gt 1 ]; then error_exit "use one of --share, --links, --revoke-link, --revoke-links, --public, --cancel-public, --private, --refresh-thumbnail at a time"; fi
  if [ "$ACTIONS" -eq 1 ]; then
    [ -n "$APP" ] || error_exit "--app <appId> is required (see --list)"
    if $SHARE; then
      BODY=$(jq -cn --arg t "$TTL_DAYS" 'if $t != "" then {ttlDays: ($t|tonumber)} else {} end')
      RESPONSE=$(call POST "/apps/${APP}/share" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c '.data | {success: true, appId, url: ("https://apps.crewlyai.com/" + .appId), visibility, publicRequestPending} + '"$CARD_JQ"
    elif $LINKS; then
      RESPONSE=$(call GET "/apps/${APP}/links") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c '{success: true, links: [.data[]? | {linkId, active, uses, createdAt, expiresAt, lastUsedAt, revokedAt, createdBy}]}'
    elif [ -n "$REVOKE_LINK" ]; then
      [[ "$REVOKE_LINK" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || error_exit "--revoke-link takes a link id from --links"
      RESPONSE=$(call DELETE "/apps/${APP}/links/${REVOKE_LINK}") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c --arg id "$REVOKE_LINK" '{success: true, linkId: $id, revoked: .data.revoked}'
    elif $REVOKE_LINKS; then
      RESPONSE=$(call DELETE "/apps/${APP}/links") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c '{success: true, revoked: .data.revoked}'
    elif $PUBLIC; then
      RESPONSE=$(call POST "/apps/${APP}/visibility-request" "$PUBLIC_BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c --arg msg "$PUBLIC_MSG" '.data | {success: true, appId, url: ("https://apps.crewlyai.com/" + .appId), requested: true, message: $msg, visibility,
        publicRequest: (if .publicRequest then (.publicRequest | {publicRead, publicSubmit, note}) else null end)} + '"$CARD_JQ"
    elif $REFRESH_THUMB; then
      RESPONSE=$(call POST "/apps/${APP}/thumbnail/refresh") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c '.data | {success: (.captured == true), appId, captured} + (if .captured == true then {bytes} else {reason, message} end)'
    elif $CANCEL_PUBLIC; then
      RESPONSE=$(call DELETE "/apps/${APP}/visibility-request") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c '.data | {success: true, appId, cancelled: true, visibility}'
    else
      RESPONSE=$(call POST "/apps/${APP}/make-private") || { printf '%s\n' "$RESPONSE"; exit 1; }
      printf '%s' "$RESPONSE" | jq -c '.data | {success: true, appId, visibility}'
    fi
    exit 0
  fi
fi

# The app's owner (crewly-services apps/SPEC.md §15): who its comments go to.
OWNER_JQ='(.data.owner | if . == null then null else {kind, name, default: (.explicit | not)} end)'
if [ -n "$OWNER_SPEC" ] && [ -z "$DIR" ] && [ -z "$FILE" ]; then
  [ -n "$APP" ] || error_exit "--app is required with --owner (or publish with --dir / --html)"
  RESPONSE=$(call PUT "/apps/${APP}/owner" "$(jq -cn --arg o "$OWNER_SPEC" '{owner: $o}')") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: true, appId: .data.appId, owner: '"$OWNER_JQ"'}'
  exit 0
fi

if [ -n "$TRANSFER_TO" ]; then
  [ -n "$APP" ] || error_exit "--app is required with --transfer-to"
  BODY=$(jq -cn --arg s "$TRANSFER_TO" '{toSession: $s}')
  RESPONSE=$(call POST "/apps/${APP}/transfer" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
  printf '%s' "$RESPONSE" | jq -c '{success: true, appId: .data.appId, publisher: .data.publisher, previous: .data.previous, changed: .data.changed, notified: .data.notified}'
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
  printf '%s' "$RESPONSE" | jq -c '{success: true, appId: .data.appId, url: ("https://apps.crewlyai.com/" + .data.appId), currentVersion: .data.currentVersion}
    + (if .data.publicPaused == true then {publicPaused: true, message: .data.publicPausedMessage} else {} end)'
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
PUB_PROJECT="${CREWLY_PROJECT_PATH:-$PWD}" PUB_DIR="$DIR" PUB_FILE="$FILE" PUB_NAME="$NAME" PUB_APP="$APP" PUB_ENTRY="$ENTRY" PUB_NOTE="$NOTE" PUB_NOTIFY="$( $NOTIFY || $SHARE && echo true || echo false )" PUB_PUBLIC="$PUBLIC_BODY" PUB_OUT="$BODY_FILE" \
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
// The bundle root must be a real (non-symlink) path inside the project
// directory, and never Crewly's own home (credentials live there).
const os = require('os');
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const project = real(env.PUB_PROJECT || process.cwd());
if (!project) fail('cannot resolve the project directory');
const crewlyHomes = [path.join(os.homedir(), '.crewly'), env.CREWLY_HOME].filter(Boolean).map((p) => real(p) || path.resolve(p));
const checkRoot = (given, kind) => {
  const abs = path.resolve(given);
  let st;
  try { st = fs.lstatSync(abs); } catch { fail(`${kind === 'file' ? 'file' : 'directory'} not found: ${given}`); }
  if (st.isSymbolicLink()) fail(`${given} is a symbolic link; publish the real ${kind === 'file' ? 'file' : 'directory'}`);
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) fail(`${kind === 'file' ? 'file' : 'directory'} not found: ${given}`);
  const r = real(abs);
  if (crewlyHomes.some((h) => within(r, h))) fail(`${given} is inside Crewly's home directory; that is never published`);
  if (!within(r, project)) fail(`${given} is outside your project directory (${project})`);
  return r;
};
let source;
if (env.PUB_FILE) {
  const abs = checkRoot(env.PUB_FILE, 'file');
  if (!/\.html?$/i.test(abs)) fail('--html must be an .html file; use --dir for a multi-file app');
  source = abs;
  add(abs, 'index.html');
} else {
  const root = checkRoot(env.PUB_DIR, 'dir');
  source = root;
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
if (env.PUB_PUBLIC) body.publicRequest = JSON.parse(env.PUB_PUBLIC);
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
  OWNER_OUT='{}'
  if [ -n "$OWNER_SPEC" ]; then
    NEW_APP=$(printf '%s' "$RESP" | jq -r '.data.appId // empty')
    if OWNER_RESP=$(call PUT "/apps/${NEW_APP}/owner" "$(jq -cn --arg o "$OWNER_SPEC" '{owner: $o}')"); then
      OWNER_OUT=$(printf '%s' "$OWNER_RESP" | jq -c '{owner: '"$OWNER_JQ"'}')
    else
      # The publish went through; only the owner change failed.
      OWNER_OUT=$(printf '%s' "$OWNER_RESP" | jq -c '{ownerError: (.message // .reason // "failed")}' 2>/dev/null || echo '{"ownerError":"failed"}')
    fi
  fi
  printf '%s' "$RESP" | jq -c --arg msg "$PUBLIC_MSG" --argjson own "$OWNER_OUT" '.data | {success: true, appId, name, url: ("https://apps.crewlyai.com/" + .appId), version, created, notified} + '"$CARD_JQ"'
    + (if .publicRequested == true then {publicRequested: true, message: $msg} elif .publicRequested == false then {publicRequested: false, publicError} else {} end)
    + (if .publicPaused == true then {publicPaused: true, publicPausedMessage} else {} end) + $own'
else
  printf '%s' "$RESP" | jq -c --arg code "$CODE" '{success: false, status: ($code|tonumber), reason: (.error // "unknown"), message: (.message // ""), hint: (.hint // "")}' 2>/dev/null \
    || jq -cn --arg code "$CODE" '{success: false, status: ($code|tonumber? // 0), reason: "http_error"}'
  exit 1
fi
