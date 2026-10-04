#!/bin/bash
# =============================================================================
# app-data — read and write a Crewly App's data (the same data the app's
# page sees through crewly.db).
#
# Backed by /api/apps/:appId/data/:collection[/:docId]; the backend calls
# Crewly Cloud with its own login. specs/2026-10-04-crewly-apps-p2.md
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --app <appId> --list <collection> [--limit 100] [--after <docId>]
  bash execute.sh --app <appId> --get <collection> <docId>
  bash execute.sh --app <appId> --set <collection> <docId> --data '{"done":true}'
  bash execute.sh --app <appId> --update <collection> <docId> --data '{"done":true}' [--if-rev 4]
  bash execute.sh --app <appId> --add <collection> --data '{"name":"milk"}'
  bash execute.sh --app <appId> --delete <collection> <docId>

Options:
  --app        App id (from publish-app)
  --data       JSON object (or --data-file <path>)
  --if-rev     Only update when the doc is still at this rev (409 conflict otherwise)
  --limit      Page size for --list (1-500, default 100)
  --after      Continue a --list after this doc id (the previous page's "next")
  --help | -h  Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, status: (.status // 0), reason: (.details.error // .error // "unknown"), message: (.details.message // .details // ""), hint: (.details.hint // "")}' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s\n' "$out" | tail -n 1)"; }
  printf '%s\n' "$out" | tail -n 1
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# --data-file: a regular, non-symlink file inside the project directory
# (CREWLY_PROJECT_PATH, else the working directory), never under Crewly's home.
read_data_file() {
  command -v node >/dev/null 2>&1 || error_exit "node is required for --data-file"
  DF_PATH="$1" DF_PROJECT="${CREWLY_PROJECT_PATH:-$PWD}" node <<'NODE'
const fs = require('fs'); const path = require('path'); const os = require('os');
const fail = (m) => { process.stderr.write(JSON.stringify({ error: m }) + '\n'); process.exit(1); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (c, p) => c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
const given = process.env.DF_PATH;
const abs = path.resolve(given);
let st;
try { st = fs.lstatSync(abs); } catch { fail(`file not found: ${given}`); }
if (st.isSymbolicLink()) fail(`${given} is a symbolic link; pass the real file`);
if (!st.isFile()) fail(`${given} is not a regular file`);
const r = real(abs); const project = real(process.env.DF_PROJECT || process.cwd());
if (!project) fail('cannot resolve the project directory');
const homes = [path.join(os.homedir(), '.crewly'), process.env.CREWLY_HOME].filter(Boolean).map((p) => real(p) || path.resolve(p));
if (homes.some((h) => within(r, h))) fail(`${given} is inside Crewly's home directory`);
if (!within(r, project)) fail(`${given} is outside your project directory (${project})`);
if (st.size > 1024 * 1024) fail(`${given} is larger than 1 MB`);
process.stdout.write(fs.readFileSync(r, 'utf8'));
NODE
}

APP=""; OP=""; COLL=""; DOC=""; DATA=""; IF_REV=""; LIMIT=""; AFTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)    [ $# -ge 2 ] || error_exit "--app requires a value"; APP="$2"; shift 2 ;;
    --list|--add)
      [ $# -ge 2 ] || error_exit "$1 requires a collection"
      OP="${1#--}"; COLL="$2"; shift 2 ;;
    --get|--set|--update|--delete)
      [ $# -ge 3 ] || error_exit "$1 requires a collection and a doc id"
      OP="${1#--}"; COLL="$2"; DOC="$3"; shift 3 ;;
    --data)      [ $# -ge 2 ] || error_exit "--data requires a value";      DATA="$2"; shift 2 ;;
    --data-file) [ $# -ge 2 ] || error_exit "--data-file requires a value"; DATA="$(read_data_file "$2")" || exit 1; shift 2 ;;
    --if-rev)    [ $# -ge 2 ] || error_exit "--if-rev requires a value";    IF_REV="$2"; shift 2 ;;
    --limit)     [ $# -ge 2 ] || error_exit "--limit requires a value";     LIMIT="$2"; shift 2 ;;
    --after)     [ $# -ge 2 ] || error_exit "--after requires a value";     AFTER="$2"; shift 2 ;;
    --help|-h)   print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

[ -n "$APP" ] || error_exit "--app is required"
[ -n "$OP" ] || error_exit "one of --list / --get / --set / --update / --add / --delete is required"
[[ "$APP" =~ ^[a-z0-9]{10}$ ]] || error_exit "--app must be a 10-character app id"
case "$COLL" in .|..) error_exit "collection cannot be . or .." ;; esac
case "$DOC" in .|..) error_exit "doc id cannot be . or .." ;; esac
BASE="/apps/${APP}/data/$(uri "$COLL")"

need_data() {
  [ -n "$DATA" ] || error_exit "--data is required for --$OP"
  printf '%s' "$DATA" | jq -e 'type == "object"' >/dev/null 2>&1 || error_exit "--data must be a JSON object"
}

case "$OP" in
  list)
    Q=""
    [ -n "$LIMIT" ] && Q="limit=$(uri "$LIMIT")"
    [ -n "$AFTER" ] && Q="${Q:+$Q&}after=$(uri "$AFTER")"
    RESPONSE=$(call GET "${BASE}${Q:+?$Q}") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, docs: [.data.docs[]? | {id, data, rev, updatedAt, updatedBy: (.updatedBy.kind // null)}], next: .data.next}'
    ;;
  get)
    RESPONSE=$(call GET "${BASE}/$(uri "$DOC")") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, id: .data.id, data: .data.data, rev: .data.rev, updatedAt: .data.updatedAt}'
    ;;
  set)
    need_data
    RESPONSE=$(call PUT "${BASE}/$(uri "$DOC")" "$(jq -cn --argjson d "$DATA" '{data: $d}')") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, id: .data.id, rev: .data.rev}'
    ;;
  update)
    need_data
    if [ -n "$IF_REV" ]; then
      [[ "$IF_REV" =~ ^[0-9]+$ ]] || error_exit "--if-rev must be a number"
      BODY=$(jq -cn --argjson d "$DATA" --argjson r "$IF_REV" '{data: $d, ifRev: $r}')
    else
      BODY=$(jq -cn --argjson d "$DATA" '{data: $d}')
    fi
    RESPONSE=$(call PATCH "${BASE}/$(uri "$DOC")" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, id: .data.id, rev: .data.rev}'
    ;;
  add)
    need_data
    RESPONSE=$(call POST "$BASE" "$(jq -cn --argjson d "$DATA" '{data: $d}')") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, id: .data.id, rev: .data.rev}'
    ;;
  delete)
    RESPONSE=$(call DELETE "${BASE}/$(uri "$DOC")") || { printf '%s\n' "$RESPONSE"; exit 1; }
    printf '%s' "$RESPONSE" | jq -c '{success: true, deleted: true}'
    ;;
esac
