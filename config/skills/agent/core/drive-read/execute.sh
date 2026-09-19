#!/bin/bash
# =============================================================================
# drive-read — Read a Drive file's content (Docs/Sheets/Slides exported as text/CSV; other files downloaded)
#
# Backed by GET /api/google/drive/files/:id/content.
#
# Usage:
#   bash execute.sh --id <fileId> [--out /path/to/save]
#   bash execute.sh '{"id":"<fileId>"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id <fileId> [--out /path/to/save]
  bash execute.sh '{"id":"<fileId>"}'

Options:
  --id          Drive file id (required; from drive-search)
  --out         Save the content to this path instead of printing it (binary files are decoded)
  --help | -h   Show this help
EOF_USAGE
}

fail_from() {
  printf '%s' "$1" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -n --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# api_call may print a one-line warning to stderr (no CREWLY_SESSION_NAME);
# the backend answer is always the last line. On failure print the mapped
# failure JSON (fail_from) and return 1.
call() {
  local out
  out=$(api_call "$@" 2>&1) || { fail_from "$(printf '%s
' "$out" | tail -n 1)"; }
  printf '%s
' "$out" | tail -n 1
}

INPUT_JSON=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi
ID=""; OUT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)      [ $# -ge 2 ] || error_exit "--id requires a value";  ID="$2";       shift 2 ;;
    --out|-o)  [ $# -ge 2 ] || error_exit "--out requires a value"; OUT_PATH="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ID" ]       && ID=$(printf '%s' "$INPUT" | jq -r '.id // .fileId // empty')
  [ -z "$OUT_PATH" ] && OUT_PATH=$(printf '%s' "$INPUT" | jq -r '.out // empty')
fi
require_param "id (--id)" "$ID"
RESPONSE=$(call GET "/google/drive/files/$(uri "$ID")/content") || { printf '%s\n' "$RESPONSE"; exit 1; }
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then printf '%s\n' "$RESPONSE"; exit 0; fi
if [ -n "$OUT_PATH" ]; then
  ENC=$(printf '%s' "$RESPONSE" | jq -r '.data.encoding')
  if [ "$ENC" = "base64" ]; then
    printf '%s' "$RESPONSE" | jq -r '.data.content' | base64 -d > "$OUT_PATH"
  else
    printf '%s' "$RESPONSE" | jq -r '.data.content' > "$OUT_PATH"
  fi
  printf '%s' "$RESPONSE" | jq -c --arg p "$OUT_PATH" '{file: .data.file, contentType: .data.contentType, bytes: .data.bytes, savedTo: $p}'
  exit 0
fi
printf '%s' "$RESPONSE" | jq -c '{file: .data.file, contentType: .data.contentType, encoding: .data.encoding, bytes: .data.bytes, content: .data.content}'
