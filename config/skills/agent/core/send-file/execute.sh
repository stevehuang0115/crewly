#!/bin/bash
# =============================================================================
# send-file — hand a large file to another agent of the same Crewly account
# through the Cloud file-handoff relay (crewly-services apps/SPEC.md section 18).
#
# The backend (POST /api/apps/handoffs) asks Cloud for a presigned upload URL;
# this script then streams the file straight to object storage with curl -T
# (from disk, never buffered), and confirms with /complete.
#
# Usage:
#   bash execute.sh --path <file> [--name <name>] [--note <text>] [--to <agent>] [--content-type <type>]
#   bash execute.sh --cancel <handoffId>
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --path <file> [--name <name>] [--note <text>] [--to <agent>] [--content-type <type>]
  bash execute.sh --cancel <handoffId>

Options:
  --path          Regular file inside your project directory, up to 2 GB (required)
  --name          Name the receiver sees (default: the file's name)
  --note          One line for the receiver
  --to            Who it is for (informational; any agent of the account can receive it)
  --content-type  MIME type (default: from the extension)
  --cancel        Withdraw a handoff you made (deletes the uploaded file)
  --help | -h     Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, status: (.status // 0), reason: (.details.error // .error // "unknown"), message: (.details.message // .details // "")}' 2>/dev/null \
    || jq -cn --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s\n' "$out" | tail -n 1)"; }
  printf '%s\n' "$out" | tail -n 1
}

content_type_for() {
  case "$(printf '%s' "${1##*.}" | tr '[:upper:]' '[:lower:]')" in
    mp4|m4v) echo video/mp4 ;;
    mov) echo video/quicktime ;;
    webm) echo video/webm ;;
    mkv) echo video/x-matroska ;;
    mp3) echo audio/mpeg ;;
    wav) echo audio/wav ;;
    m4a) echo audio/mp4 ;;
    png) echo image/png ;;
    jpg|jpeg) echo image/jpeg ;;
    pdf) echo application/pdf ;;
    zip) echo application/zip ;;
    json) echo application/json ;;
    csv) echo text/csv ;;
    txt|md|log) echo text/plain ;;
    *) echo application/octet-stream ;;
  esac
}

# Regular, non-symlink file inside the project directory, never under Crewly's
# home. Prints the real path, then the size in bytes.
check_file() {
  command -v node >/dev/null 2>&1 || error_exit "node is required"
  CF_PATH="$1" CF_PROJECT="${CREWLY_PROJECT_PATH:-$PWD}" node <<'NODE'
const fs = require('fs'); const path = require('path'); const os = require('os');
const fail = (m) => { process.stderr.write(JSON.stringify({ error: m }) + '\n'); process.exit(1); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (c, p) => c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
const given = process.env.CF_PATH;
const abs = path.resolve(given);
let st;
try { st = fs.lstatSync(abs); } catch { fail(`file not found: ${given}`); }
if (st.isSymbolicLink()) fail(`${given} is a symbolic link; pass the real file`);
if (!st.isFile()) fail(`${given} is not a regular file`);
if (st.size === 0) fail(`${given} is empty`);
const r = real(abs); const project = real(process.env.CF_PROJECT || process.cwd());
if (!project) fail('cannot resolve the project directory');
const homes = [path.join(os.homedir(), '.crewly'), process.env.CREWLY_HOME].filter(Boolean).map((p) => real(p) || path.resolve(p));
if (homes.some((h) => within(r, h))) fail(`${given} is inside Crewly's home directory`);
if (!within(r, project)) fail(`${given} is outside your project directory (${project}); copy it there first`);
process.stdout.write(r + '\n' + st.size + '\n');
NODE
}

FILE=""; NAME=""; NOTE=""; TO=""; CTYPE=""; CANCEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)         [ $# -ge 2 ] || error_exit "--path requires a value"; FILE="$2"; shift 2 ;;
    --name)         [ $# -ge 2 ] || error_exit "--name requires a value"; NAME="$2"; shift 2 ;;
    --note)         [ $# -ge 2 ] || error_exit "--note requires a value"; NOTE="$2"; shift 2 ;;
    --to)           [ $# -ge 2 ] || error_exit "--to requires a value"; TO="$2"; shift 2 ;;
    --content-type) [ $# -ge 2 ] || error_exit "--content-type requires a value"; CTYPE="$2"; shift 2 ;;
    --cancel)       [ $# -ge 2 ] || error_exit "--cancel requires a handoff id"; CANCEL="$2"; shift 2 ;;
    --help|-h)      print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done

if [ -n "$CANCEL" ]; then
  [[ "$CANCEL" =~ ^hf_[A-Za-z0-9_-]{22}$ ]] || error_exit "--cancel needs a handoff id like hf_…"
  RESULT=$(call DELETE "/apps/handoffs/${CANCEL}") || { printf '%s\n' "$RESULT"; exit 1; }
  jq -cn --arg id "$CANCEL" '{success: true, handoffId: $id, cancelled: true}'
  exit 0
fi

[ -n "$FILE" ] || error_exit "--path is required"
INFO=$(check_file "$FILE") || { printf '%s\n' "$INFO" >&2; exit 1; }
REAL=$(printf '%s\n' "$INFO" | sed -n 1p)
SIZE=$(printf '%s\n' "$INFO" | sed -n 2p)
[ -n "$NAME" ] || NAME="$(basename "$REAL")"
[ -n "$CTYPE" ] || CTYPE="$(content_type_for "$REAL")"

BODY=$(jq -cn --arg n "$NAME" --argjson s "$SIZE" --arg c "$CTYPE" --arg note "$NOTE" --arg to "$TO" \
  '{fileName: $n, sizeBytes: $s, contentType: $c} + (if $note != "" then {note: $note} else {} end) + (if $to != "" then {to: $to} else {} end)')
CREATED=$(call POST "/apps/handoffs" "$BODY") || { printf '%s\n' "$CREATED"; exit 1; }
ID=$(printf '%s' "$CREATED" | jq -r '.data.handoffId // empty')
URL=$(printf '%s' "$CREATED" | jq -r '.data.upload.url // empty')
[ -n "$ID" ] && [ -n "$URL" ] || error_exit "Cloud answered without an upload URL"

# Headers the presigned URL was signed with; the file streams from disk (-T).
HDRS=()
while IFS= read -r line; do HDRS+=(-H "$line"); done < <(printf '%s' "$CREATED" | jq -r '.data.upload.headers // {} | to_entries[] | "\(.key): \(.value)"')

cancel_quietly() { api_call DELETE "/apps/handoffs/${ID}" >/dev/null 2>&1 || true; }

CODE=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 30 --retry 3 --retry-delay 3 -X PUT -T "$REAL" ${HDRS[@]+"${HDRS[@]}"} "$URL" 2>/dev/null) || CODE="000"
if [ "$CODE" != "200" ]; then
  cancel_quietly
  jq -cn --arg c "$CODE" '{success: false, reason: "upload_failed", message: ("The upload to temporary storage failed (HTTP " + $c + "). Nothing was kept; try again.")}'
  exit 1
fi

DONE=$(api_call POST "/apps/handoffs/${ID}/complete" 2>&1) || { cancel_quietly; fail_from "$(printf '%s\n' "$DONE" | tail -n 1)"; }
EXPIRES=$(printf '%s\n' "$DONE" | tail -n 1 | jq -r '.data.expiresAt // empty')

jq -cn --arg id "$ID" --arg n "$NAME" --argjson s "$SIZE" --arg e "$EXPIRES" \
  '{success: true, handoffId: $id, fileName: $n, sizeBytes: $s, expiresAt: $e,
    instruction: ("Receive it with the receive-file skill: bash <skills>/core/receive-file/execute.sh --id " + $id + " [--dir <folder>]")}'
