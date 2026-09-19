#!/bin/bash
# =============================================================================
# drive-upload — Upload a file (or text) to the owner's Google Drive
#
# Backed by POST /api/google/drive/files.
#
# Usage:
#   bash execute.sh --path /path/report.pdf [--name "Report.pdf"] [--folder <id>] [--convert doc|sheet|slides]
#   bash execute.sh --name notes.txt --text "hello" [--mime text/plain]
#   bash execute.sh '{"name":"notes.txt","text":"hello","folder":"<id>"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --path /path/report.pdf [--name "Report.pdf"] [--folder <id>] [--convert doc|sheet|slides]
  bash execute.sh --name notes.txt --text "hello" [--mime text/plain]
  bash execute.sh '{"name":"notes.txt","text":"hello","folder":"<id>"}'

Options:
  --path, -p    Local file to upload (binary-safe; MIME detected from the extension).
                (Not --file: that flag is reserved by the skill runner for JSON input.)
  --name        Name in Drive (default: the file's basename)
  --text        Text content instead of --path
  --mime        MIME type override
  --folder      Destination folder id (default: My Drive root)
  --convert     Convert on upload: doc | sheet | slides (e.g. a .docx/.csv/.pptx becomes a Google-native file)
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
FILE=""; NAME=""; TEXT=""; MIME=""; FOLDER=""; CONVERT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path|-p) [ $# -ge 2 ] || error_exit "--path requires a value";    FILE="$2";    shift 2 ;;
    --name)    [ $# -ge 2 ] || error_exit "--name requires a value";    NAME="$2";    shift 2 ;;
    --text)    [ $# -ge 2 ] || error_exit "--text requires a value";    TEXT="$2";    shift 2 ;;
    --mime)    [ $# -ge 2 ] || error_exit "--mime requires a value";    MIME="$2";    shift 2 ;;
    --folder)  [ $# -ge 2 ] || error_exit "--folder requires a value";  FOLDER="$2";  shift 2 ;;
    --convert) [ $# -ge 2 ] || error_exit "--convert requires a value"; CONVERT="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$FILE" ]    && FILE=$(printf '%s' "$INPUT" | jq -r '.path // .file // empty')
  [ -z "$NAME" ]    && NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
  [ -z "$TEXT" ]    && TEXT=$(printf '%s' "$INPUT" | jq -r '.text // .content // empty')
  [ -z "$MIME" ]    && MIME=$(printf '%s' "$INPUT" | jq -r '.mime // .mimeType // empty')
  [ -z "$FOLDER" ]  && FOLDER=$(printf '%s' "$INPUT" | jq -r '.folder // .folderId // empty')
  [ -z "$CONVERT" ] && CONVERT=$(printf '%s' "$INPUT" | jq -r '.convert // .convertTo // empty')
fi
case "$CONVERT" in
  doc|docs) CONVERT="application/vnd.google-apps.document" ;;
  sheet|sheets) CONVERT="application/vnd.google-apps.spreadsheet" ;;
  slides|slide|presentation) CONVERT="application/vnd.google-apps.presentation" ;;
esac
mime_from_ext() {
  case "${1##*.}" in
    txt) echo text/plain ;; md) echo text/markdown ;; csv) echo text/csv ;; json) echo application/json ;;
    html|htm) echo text/html ;; pdf) echo application/pdf ;; png) echo image/png ;; jpg|jpeg) echo image/jpeg ;;
    gif) echo image/gif ;; mp4) echo video/mp4 ;; zip) echo application/zip ;;
    docx) echo application/vnd.openxmlformats-officedocument.wordprocessingml.document ;;
    xlsx) echo application/vnd.openxmlformats-officedocument.spreadsheetml.sheet ;;
    pptx) echo application/vnd.openxmlformats-officedocument.presentationml.presentation ;;
    *) echo application/octet-stream ;;
  esac
}
ENCODING="utf8"; CONTENT=""
if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || error_exit "file not found: $FILE"
  [ -z "$NAME" ] && NAME=$(basename "$FILE")
  [ -z "$MIME" ] && MIME=$(mime_from_ext "$FILE")
  case "$MIME" in
    text/*|application/json) CONTENT=$(cat "$FILE") ;;
    *) ENCODING="base64"; CONTENT=$(base64 < "$FILE" | tr -d '\n') ;;
  esac
else
  CONTENT="$TEXT"
  [ -z "$MIME" ] && MIME="text/plain"
fi
require_param "name (--name or --path)" "$NAME"
require_param "content (--path or --text)" "$CONTENT"
BODY=$(jq -cn --arg name "$NAME" --arg content "$CONTENT" --arg enc "$ENCODING" --arg mime "$MIME" --arg folder "$FOLDER" --arg convert "$CONVERT" \
  '{name: $name, content: $content, encoding: $enc, mimeType: $mime}
   + (if $folder != "" then {folderId: $folder} else {} end)
   + (if $convert != "" then {convertTo: $convert} else {} end)')
RESPONSE=$(call POST "/google/drive/files" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), file: .data}'
