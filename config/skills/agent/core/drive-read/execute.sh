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
  --full        Print an oversized file's content inline instead of the truncated envelope (prefer --out)
  --account     Which connected Google account to act as (default: your primary)
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
ID=""; OUT_PATH=""; ACCOUNT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)      [ $# -ge 2 ] || error_exit "--id requires a value";  ID="$2";       shift 2 ;;
    --out|-o)  [ $# -ge 2 ] || error_exit "--out requires a value"; OUT_PATH="$2"; shift 2 ;;
    --account)  [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --full)    shift ;;  # lib.sh already read it (no output cap); accepted so the envelope hint's advice works
    --help|-h) print_usage; exit 0 ;;
    *) unknown_arg_exit "$1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ID" ]       && ID=$(printf '%s' "$INPUT" | jq -r '.id // .fileId // empty')
  [ -z "$OUT_PATH" ] && OUT_PATH=$(printf '%s' "$INPUT" | jq -r '.out // empty')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
# Route the call at one connected Google account; unset means the default.
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"
require_param "id (--id)" "$ID"
# --out writes the bytes to a file and prints only a small summary, so the full
# body never reaches the model: skip the output cap for this call. Without --out
# the cap stays on (a big file must not flood the conversation).
[ -n "$OUT_PATH" ] && export CREWLY_SKILL_FULL_OUTPUT=1
RESPONSE=$(call GET "/google/drive/files/$(uri "$ID")/content") || { printf '%s\n' "$RESPONSE"; exit 1; }
if printf '%s' "$RESPONSE" | jq -e '.truncated == true' >/dev/null 2>&1; then
  if [ -z "$OUT_PATH" ]; then
    # Too big to print: say how to get the whole file instead of a bare envelope.
    printf '%s' "$RESPONSE" | jq -c '. + {next: "Content is too large to print. Re-run with --out <path> to save the whole file."}'
    exit 0
  fi
  # --out but the cap still replaced the body (should not happen): use the parked
  # file; if it is unreadable fail loudly, never report success with no file.
  PARKED=$(printf '%s' "$RESPONSE" | jq -r '.file // empty')
  if [ -n "$PARKED" ] && [ -r "$PARKED" ]; then
    RESPONSE=$(tail -n 1 "$PARKED")
  else
    jq -nc --arg f "$PARKED" '{success: false, reason: "truncated_response", message: ("the response was replaced by a truncated envelope and its parked file is unreadable: " + $f)}'
    exit 1
  fi
fi
if [ -n "$OUT_PATH" ]; then
  if ! printf '%s' "$RESPONSE" | jq -e '.data.content != null' >/dev/null 2>&1; then
    jq -nc '{success: false, reason: "no_content", message: "the response has no data.content; nothing was saved"}'
    exit 1
  fi
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
