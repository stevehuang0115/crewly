#!/bin/bash
# =============================================================================
# canva-export — Export a Canva design to PDF / PNG / JPG / PPTX / GIF / MP4 and download it
#
# Backed by POST /api/canva/designs/:id/export (async job, polled by the backend).
#
# Usage:
#   bash execute.sh --id <designId> --format pdf [--out /tmp/poster.pdf]
#   bash execute.sh --id <designId> --format mp4 [--video-quality horizontal_1080p] --out /tmp/reel.mp4
#   bash execute.sh --id <designId> --format png --pages 1,2 --out-dir /tmp/pages
#   bash execute.sh '{"id":"<designId>","format":"jpg","quality":85}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --id <designId> --format pdf [--out /tmp/poster.pdf]
  bash execute.sh --id <designId> --format mp4 [--video-quality horizontal_1080p] --out /tmp/reel.mp4
  bash execute.sh --id <designId> --format png --pages 1,2 --out-dir /tmp/pages
  bash execute.sh '{"id":"<designId>","format":"jpg","quality":85}'

Options:
  --id            Design id (required)
  --format        pdf | png | jpg | pptx | gif | mp4 (required)
  --quality       JPG quality 1–100 (default 80)
  --video-quality MP4 preset: horizontal_480p|720p|1080p|4k, vertical_… (default horizontal_1080p)
  --pages         Comma-separated 1-based page numbers (default all)
  --out           Download the (first) file to this path
  --out-dir       Download every file into this directory (page-1.png, page-2.png, …)
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
ID=""; FORMAT=""; QUALITY=""; VQ=""; PAGES=""; OUT_PATH=""; OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)            [ $# -ge 2 ] || error_exit "--id requires a value";            ID="$2";       shift 2 ;;
    --format|-f)     [ $# -ge 2 ] || error_exit "--format requires a value";        FORMAT="$2";   shift 2 ;;
    --quality)       [ $# -ge 2 ] || error_exit "--quality requires a value";       QUALITY="$2";  shift 2 ;;
    --video-quality) [ $# -ge 2 ] || error_exit "--video-quality requires a value"; VQ="$2";       shift 2 ;;
    --pages)         [ $# -ge 2 ] || error_exit "--pages requires a value";         PAGES="$2";    shift 2 ;;
    --out|-o)        [ $# -ge 2 ] || error_exit "--out requires a value";           OUT_PATH="$2"; shift 2 ;;
    --out-dir)       [ $# -ge 2 ] || error_exit "--out-dir requires a value";       OUT_DIR="$2";  shift 2 ;;
    --help|-h)       print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ID" ]       && ID=$(printf '%s' "$INPUT" | jq -r '.id // .designId // empty')
  [ -z "$FORMAT" ]   && FORMAT=$(printf '%s' "$INPUT" | jq -r '.format // empty')
  [ -z "$QUALITY" ]  && QUALITY=$(printf '%s' "$INPUT" | jq -r '.quality // empty')
  [ -z "$VQ" ]       && VQ=$(printf '%s' "$INPUT" | jq -r '.videoQuality // empty')
  [ -z "$PAGES" ]    && PAGES=$(printf '%s' "$INPUT" | jq -r '(.pages // []) | map(tostring) | join(",")')
  [ -z "$OUT_PATH" ] && OUT_PATH=$(printf '%s' "$INPUT" | jq -r '.out // empty')
  [ -z "$OUT_DIR" ]  && OUT_DIR=$(printf '%s' "$INPUT" | jq -r '.outDir // empty')
fi
require_param "id (--id)" "$ID"
require_param "format (--format)" "$FORMAT"
BODY=$(jq -cn --arg format "$FORMAT" --arg q "$QUALITY" --arg vq "$VQ" --arg pages "$PAGES" \
  '{format: $format}
   + (if $q != "" then {quality: ($q|tonumber)} else {} end)
   + (if $vq != "" then {videoQuality: $vq} else {} end)
   + (if $pages != "" then {pages: ($pages | split(",") | map(tonumber))} else {} end)')
RESPONSE=$(call POST "/canva/designs/$(uri "$ID")/export" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
STATUS=$(printf '%s' "$RESPONSE" | jq -r '.data.status // "failed"')
if [ "$STATUS" != "success" ]; then
  printf '%s' "$RESPONSE" | jq -c '{success: false, reason: "export_failed", status: .data.status, error: .data.error}'
  exit 1
fi
SAVED="[]"
if [ -n "$OUT_PATH" ] || [ -n "$OUT_DIR" ]; then
  i=0
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    i=$((i+1))
    if [ -n "$OUT_PATH" ] && [ "$i" -eq 1 ]; then dest="$OUT_PATH"
    elif [ -n "$OUT_DIR" ]; then mkdir -p "$OUT_DIR"; dest="$OUT_DIR/page-$i.$FORMAT"
    else continue; fi
    curl -sfL -o "$dest" "$url" || error_exit "download failed: $url"
    SAVED=$(printf '%s' "$SAVED" | jq -c --arg d "$dest" '. + [$d]')
  done < <(printf '%s' "$RESPONSE" | jq -r '.data.urls[]')
fi
printf '%s' "$RESPONSE" | jq -c --argjson saved "$SAVED" '{success: true, jobId: .data.jobId, urls: .data.urls, savedTo: $saved}'
