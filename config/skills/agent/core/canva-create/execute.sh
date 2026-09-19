#!/bin/bash
# =============================================================================
# canva-create — Create a new Canva design (preset type, custom size, or from an uploaded asset)
#
# Backed by POST /api/canva/designs.
#
# Usage:
#   bash execute.sh --title "Open day poster" --size 1080x1350
#   bash execute.sh --title "Term plan" --preset presentation      # doc | whiteboard | presentation
#   bash execute.sh --title "Flyer" --asset <assetId>              # start from an uploaded image
#   bash execute.sh '{"title":"Poster","width":1080,"height":1920}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --title "Open day poster" --size 1080x1350
  bash execute.sh --title "Term plan" --preset presentation      # doc | whiteboard | presentation
  bash execute.sh --title "Flyer" --asset <assetId>              # start from an uploaded image
  bash execute.sh '{"title":"Poster","width":1080,"height":1920}'

Options:
  --title       Design title (≤ 255 chars)
  --preset      doc | whiteboard | presentation
  --size        WIDTHxHEIGHT in px (40–8000), e.g. 1080x1920 for a vertical video/story
  --asset       Asset id from canva-upload to place on the first page
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
TITLE=""; PRESET=""; SIZE=""; WIDTH=""; HEIGHT=""; ASSET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)   [ $# -ge 2 ] || error_exit "--title requires a value";  TITLE="$2";  shift 2 ;;
    --preset)  [ $# -ge 2 ] || error_exit "--preset requires a value"; PRESET="$2"; shift 2 ;;
    --size)    [ $# -ge 2 ] || error_exit "--size requires a value";   SIZE="$2";   shift 2 ;;
    --asset)   [ $# -ge 2 ] || error_exit "--asset requires a value";  ASSET="$2";  shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TITLE" ]  && TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  [ -z "$PRESET" ] && PRESET=$(printf '%s' "$INPUT" | jq -r '.preset // empty')
  [ -z "$WIDTH" ]  && WIDTH=$(printf '%s' "$INPUT" | jq -r '.width // empty')
  [ -z "$HEIGHT" ] && HEIGHT=$(printf '%s' "$INPUT" | jq -r '.height // empty')
  [ -z "$ASSET" ]  && ASSET=$(printf '%s' "$INPUT" | jq -r '.asset // .assetId // empty')
fi
if [ -n "$SIZE" ]; then
  [[ "$SIZE" =~ ^([0-9]+)x([0-9]+)$ ]] || error_exit "--size must look like 1080x1920"
  WIDTH="${BASH_REMATCH[1]}"; HEIGHT="${BASH_REMATCH[2]}"
fi
[ -n "$PRESET" ] || [ -n "$WIDTH" ] || [ -n "$ASSET" ] || error_exit "give --preset, --size or --asset"
BODY=$(jq -cn --arg title "$TITLE" --arg preset "$PRESET" --arg w "$WIDTH" --arg h "$HEIGHT" --arg asset "$ASSET" \
  '{} + (if $title != "" then {title: $title} else {} end)
      + (if $preset != "" then {preset: $preset} else {} end)
      + (if $w != "" then {width: ($w|tonumber), height: ($h|tonumber)} else {} end)
      + (if $asset != "" then {assetId: $asset} else {} end)')
RESPONSE=$(call POST "/canva/designs" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), design: .data}'
