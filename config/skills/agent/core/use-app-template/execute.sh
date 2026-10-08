#!/bin/bash
# =============================================================================
# use-app-template — start a new Crewly App from a Marketplace template.
#
# Backed by POST /api/apps/templates/:templateId/use (a new app in this
# account + the template's files) and POST /api/apps/:appId/template-files
# (the files of an app the owner already started from a template).
# specs/2026-10-08-app-templates.md
#
# The files are written by this script (as you), into a new or empty
# directory inside your project — never outside it, never into Crewly's home.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh <templateId> --dir ./my-app [--name "Name"]
  bash execute.sh --app <appId> --dir ./my-app      # files of an app already made from a template

Options:
  --template   Template id (tpl-…, from find-app-template); or pass it as the first argument
  --dir        New or empty directory in your project to write the files into (required)
  --name       Name of the new app (default: the template's)
  --app        An app made from a template (e.g. by the owner in the portal): write its template's files
  --help | -h  Show this help
EOF_USAGE
}

TEMPLATE=""; DIR=""; NAME=""; APP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --template) [ $# -ge 2 ] || error_exit "--template requires a value"; TEMPLATE="$2"; shift 2 ;;
    --dir)      [ $# -ge 2 ] || error_exit "--dir requires a value"; DIR="$2"; shift 2 ;;
    --name)     [ $# -ge 2 ] || error_exit "--name requires a value"; NAME="$2"; shift 2 ;;
    --app)      [ $# -ge 2 ] || error_exit "--app requires a value"; APP="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) if [ -z "$TEMPLATE" ] && [ "${1:0:1}" != "-" ]; then TEMPLATE="$1"; shift; else error_exit "Unknown option: $1"; fi ;;
  esac
done

[ -n "$DIR" ] || error_exit "--dir is required: a new or empty directory in your project for the app's files"
if [ -n "$APP" ]; then
  [ -z "$TEMPLATE" ] || error_exit "use a template id or --app, not both"
  [[ "$APP" =~ ^[a-km-np-z2-9]{10}$ ]] || error_exit "--app must be a 10-character Crewly app id"
else
  [ -n "$TEMPLATE" ] || error_exit "a template id is required (tpl-…, from find-app-template)"
  [[ "$TEMPLATE" =~ ^tpl-[a-km-np-z2-9]{10}$ ]] || error_exit "the template id looks like tpl-xxxxxxxxxx (from find-app-template)"
fi
[ ${#NAME} -le 80 ] || error_exit "--name is at most 80 characters"
command -v node >/dev/null 2>&1 || error_exit "node is required to write the app files"

# Resolve and check the target directory (created here, empty), and print its real path.
SOURCE=$(USE_PROJECT="${CREWLY_PROJECT_PATH:-$PWD}" USE_DIR="$DIR" node <<'NODE'
const fs = require('fs'), path = require('path'), os = require('os');
const fail = (m) => { process.stderr.write(JSON.stringify({ error: m }) + '\n'); process.exit(1); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (c, p) => c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
const project = real(process.env.USE_PROJECT);
if (!project) fail('cannot resolve the project directory');
const homes = [path.join(os.homedir(), '.crewly'), process.env.CREWLY_HOME].filter(Boolean).map((p) => real(p) || path.resolve(p));
const abs = path.resolve(process.env.USE_DIR);
let st = null;
try { st = fs.lstatSync(abs); } catch {}
if (st && st.isSymbolicLink()) fail(`${process.env.USE_DIR} is a symbolic link; use a real directory`);
const parent = real(path.dirname(abs));
if (!parent) fail(`the parent of ${process.env.USE_DIR} does not exist`);
const target = st ? real(abs) : path.join(parent, path.basename(abs));
if (homes.some((h) => within(target, h))) fail(`${process.env.USE_DIR} is inside Crewly's home directory; use your project directory`);
if (!within(target, project) || target === project) fail(`${process.env.USE_DIR} must be a directory inside your project (${project})`);
if (st && !st.isDirectory()) fail(`${process.env.USE_DIR} is a file, not a directory`);
if (st && fs.readdirSync(abs).filter((n) => !n.startsWith('.')).length) fail(`${process.env.USE_DIR} is not empty; choose a new directory so nothing of yours is overwritten`);
process.stdout.write(target);
NODE
) || exit 1

if [ -n "$APP" ]; then
  ENDPOINT="/api/apps/${APP}/template-files"
  BODY=$(jq -cn --arg s "$SOURCE" '{source: $s}')
else
  ENDPOINT="/api/apps/templates/${TEMPLATE}/use"
  BODY=$(jq -cn --arg s "$SOURCE" --arg n "$NAME" '{source: $s} + (if $n != "" then {name: $n} else {} end)')
fi

OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/crewly-template-XXXXXX")"
trap 'rm -f "$OUT_FILE"' EXIT
AUTH=()
while IFS= read -r a; do AUTH+=("$a"); done < <(agent_auth_curl_args)
[ -n "${CREWLY_SESSION_NAME:-}" ] && AUTH+=(-H "X-Agent-Pid: $$")
CODE=$(curl -s -o "$OUT_FILE" -w '%{http_code}' -X POST -H "Content-Type: application/json" ${AUTH[@]+"${AUTH[@]}"} \
  --data-binary "$BODY" "${CREWLY_API_URL}${ENDPOINT}") || error_exit "could not reach the Crewly backend at ${CREWLY_API_URL}"
if ! [ "$CODE" -ge 200 ] 2>/dev/null || ! [ "$CODE" -lt 300 ] 2>/dev/null; then
  jq -c --arg code "$CODE" '{success: false, status: ($code|tonumber), reason: (.error // "unknown"), message: (.message // ""), hint: (.hint // "")}' "$OUT_FILE" 2>/dev/null \
    || jq -cn --arg code "$CODE" '{success: false, status: ($code|tonumber? // 0), reason: "http_error"}'
  exit 1
fi

# Write the files (paths checked again: relative, no "..", no dot-directories).
USE_OUT="$OUT_FILE" USE_TARGET="$SOURCE" node <<'NODE'
const fs = require('fs'), path = require('path');
const fail = (m) => { process.stderr.write(JSON.stringify({ error: m }) + '\n'); process.exit(1); };
const res = JSON.parse(fs.readFileSync(process.env.USE_OUT, 'utf8'));
const d = res && res.data;
if (!d || !Array.isArray(d.files) || d.files.length === 0) fail('the template has no files');
const root = process.env.USE_TARGET;
fs.mkdirSync(root, { recursive: true });
let n = 0;
for (const f of d.files) {
  const p = String(f.path || '');
  if (!p || path.isAbsolute(p) || p.split('/').some((s) => s === '..' || s === '' || s.startsWith('.'))) fail(`refusing an unsafe file path from the template: ${p.slice(0, 120)}`);
  const abs = path.join(root, ...p.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(String(f.contentBase64 || ''), 'base64'));
  n++;
}
const next = `Adapt the files in ${root} to what the owner needs, then run publish-app --dir ${root} --notify (it updates app ${d.appId}). Tell the owner in one line that you started from the Marketplace template “${d.fromTemplate && d.fromTemplate.name}”.` +
  ((d.capabilitiesNeeded || []).length ? ` It needs ${d.capabilitiesNeeded.join(', ')}: ask the owner for it as the publish-app skill says.` : '');
const out = { success: true, appId: d.appId, name: d.name, url: d.url, version: d.version, fromTemplate: d.fromTemplate, dir: root, files: n, entry: d.entry,
  ...(d.capabilitiesNeeded ? { capabilitiesNeeded: d.capabilitiesNeeded } : {}), ...(d.dataSchema ? { dataSchema: d.dataSchema } : {}), next };
process.stdout.write(JSON.stringify(out) + '\n');
NODE
