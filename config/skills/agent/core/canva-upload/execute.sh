#!/bin/bash
# =============================================================================
# canva-upload — Upload an image or video to the owner's Canva as an asset
#
# Backed by POST /api/canva/assets (base64 body; the backend polls the Canva upload job).
#
# Usage:
#   bash execute.sh --path ./logo.png [--name "School logo"]
#   bash execute.sh '{"path":"./clip.mp4","name":"Open day clip"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --path ./logo.png [--name "School logo"]
  bash execute.sh '{"path":"./clip.mp4","name":"Open day clip"}'

Options:
  --path, -p    Local image / video file (≤ 50 MB). (Not --file: reserved by the skill runner.)
  --name        Asset name in Canva (≤ 50 chars; default: the file's basename)
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
FILE=""; NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path|-p) [ $# -ge 2 ] || error_exit "--path requires a value"; FILE="$2"; shift 2 ;;
    --name)    [ $# -ge 2 ] || error_exit "--name requires a value"; NAME="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$FILE" ] && FILE=$(printf '%s' "$INPUT" | jq -r '.path // .file // empty')
  [ -z "$NAME" ] && NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
fi
require_param "path (--path)" "$FILE"
[ -f "$FILE" ] || error_exit "file not found: $FILE"
[ -z "$NAME" ] && NAME=$(basename "$FILE")
CONTENT=$(base64 < "$FILE" | tr -d '\n')
BODY=$(jq -cn --arg name "$NAME" --arg content "$CONTENT" '{name: $name, content: $content}')
RESPONSE=$(call POST "/canva/assets" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), asset: .data}'
