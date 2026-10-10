#!/bin/bash
# =============================================================================
# receive-file — download a file handed over with send-file, verify its size,
# acknowledge it (Cloud then deletes it). crewly-services apps/SPEC.md section 18.
#
# The backend (GET /api/apps/handoffs/:id) answers metadata and a presigned
# download URL; curl streams it straight to disk (resumable via a .part file).
#
# Usage:
#   bash execute.sh --id hf_… [--dir <folder>] [--no-ack]
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id hf_… [--dir <folder>] [--no-ack]

Options:
  --id        Handoff id from the sender (required)
  --dir       Folder to save into (default: received/ in your project directory)
  --no-ack    Do not delete the server copy afterwards
  --help | -h Show this help
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

ID=""; DIR=""; ACK=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)      [ $# -ge 2 ] || error_exit "--id requires a value"; ID="$2"; shift 2 ;;
    --dir)     [ $# -ge 2 ] || error_exit "--dir requires a value"; DIR="$2"; shift 2 ;;
    --no-ack)  ACK=0; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
[ -n "$ID" ] || error_exit "--id is required"
[[ "$ID" =~ ^hf_[A-Za-z0-9_-]{22}$ ]] || error_exit "--id must be a handoff id like hf_… (22 characters after hf_)"
[ -n "$DIR" ] || DIR="${CREWLY_PROJECT_PATH:-$PWD}/received"
command -v node >/dev/null 2>&1 || error_exit "node is required"

# The destination folder must not be inside the Crewly home directory.
check_dir() {
  RF_DIR="$1" node <<'NODE'
const fs = require('fs'); const path = require('path'); const os = require('os');
const abs = path.resolve(process.env.RF_DIR);
fs.mkdirSync(abs, { recursive: true });
const r = fs.realpathSync(abs);
const homes = [path.join(os.homedir(), '.crewly'), process.env.CREWLY_HOME].filter(Boolean).map((p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
if (homes.some((h) => r === h || r.startsWith(h + path.sep))) { process.stderr.write(JSON.stringify({ error: 'the folder is inside the Crewly home directory' }) + '\n'); process.exit(1); }
process.stdout.write(r);
NODE
}
DIR=$(check_dir "$DIR") || exit 1

META=$(call GET "/apps/handoffs/${ID}") || { printf '%s\n' "$META"; exit 1; }
STATUS=$(printf '%s' "$META" | jq -r '.data.status // empty')
if [ "$STATUS" != "ready" ]; then
  jq -cn '{success: false, reason: "not_ready", message: "The sender has not finished uploading. Ask them to confirm, then run this again."}'
  exit 1
fi
URL=$(printf '%s' "$META" | jq -r '.data.download.url // empty')
SIZE=$(printf '%s' "$META" | jq -r '.data.sizeBytes // empty')
RAW_NAME=$(printf '%s' "$META" | jq -r '.data.fileName // "file"')
NOTE=$(printf '%s' "$META" | jq -r '.data.note // empty')
[ -n "$URL" ] && [[ "$SIZE" =~ ^[0-9]+$ ]] || error_exit "Cloud answered without a download URL"

# A safe local name: the last path segment, no leading dots.
NAME=$(printf '%s' "$RAW_NAME" | tr '\\' '/' | awk -F/ '{print $NF}' | sed 's/^[.[:space:]]*//')
[ -n "$NAME" ] || NAME="file"

# The .part file is named by handoff id so an interrupted run resumes.
PART="${DIR}/.${ID}.part"
if [ -f "$PART" ]; then
  HAVE=$(wc -c < "$PART" | tr -d ' ')
  [ "$HAVE" -le "$SIZE" ] || rm -f "$PART"
fi
CODE=$(curl -sS -o "$PART" -w '%{http_code}' --connect-timeout 30 --retry 3 --retry-delay 3 -C - "$URL" 2>/dev/null) || CODE="000"
# 200 = whole body, 206 = resumed, 416 = the .part was already complete.
case "$CODE" in 200|206|416) ;; *)
  [ "$CODE" = "000" ] || rm -f "$PART"
  jq -cn --arg c "$CODE" '{success: false, reason: "download_failed", message: ("The download failed (HTTP " + $c + "). Run the skill again; a partial file is resumed.")}'
  exit 1 ;;
esac

GOT=$(wc -c < "$PART" | tr -d ' ')
if [ "$GOT" != "$SIZE" ]; then
  rm -f "$PART"
  jq -cn --argjson g "$GOT" --argjson s "$SIZE" '{success: false, reason: "size_mismatch", message: ("Downloaded " + ($g|tostring) + " bytes, expected " + ($s|tostring) + ". The partial file was removed and the server copy kept; run the skill again.")}'
  exit 1
fi

# Final name: never overwrite.
DEST="${DIR}/${NAME}"
if [ -e "$DEST" ]; then
  BASE="${NAME%.*}"; EXT=""
  [ "$BASE" != "$NAME" ] && EXT=".${NAME##*.}"
  N=1
  while [ -e "${DIR}/${BASE}-${N}${EXT}" ]; do N=$((N+1)); done
  DEST="${DIR}/${BASE}-${N}${EXT}"
fi
mv "$PART" "$DEST"

ACKED=false
if [ "$ACK" = "1" ]; then
  if api_call POST "/apps/handoffs/${ID}/ack" >/dev/null 2>&1; then ACKED=true; fi
fi

jq -cn --arg p "$DEST" --arg n "$NAME" --argjson s "$SIZE" --arg note "$NOTE" --argjson a "$ACKED" \
  '{success: true, path: $p, fileName: $n, sizeBytes: $s, acked: $a} + (if $note != "" then {note: $note} else {} end)
   + (if $a then {} else {warning: "The server copy was not deleted (it is removed automatically after 24 hours)."} end)'
