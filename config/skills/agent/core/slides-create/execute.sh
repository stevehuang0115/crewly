#!/bin/bash
# =============================================================================
# slides-create — Create a Google Slides deck from an outline (title + bullets per slide)
#
# Backed by POST /api/google/slides.
#
# Usage:
#   bash execute.sh --title "Pitch" --slides '[{"title":"Why now","bullets":["Market","Timing"]},{"title":"Plan"}]'
#   bash execute.sh --title "Pitch" --outline-file deck.md     # "# Slide title" then "- bullet" lines
#   bash execute.sh '{"title":"Pitch","slides":[{"title":"Why now","bullets":["Market"]}]}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --title "Pitch" --slides '[{"title":"Why now","bullets":["Market","Timing"]},{"title":"Plan"}]'
  bash execute.sh --title "Pitch" --outline-file deck.md     # "# Slide title" then "- bullet" lines
  bash execute.sh '{"title":"Pitch","slides":[{"title":"Why now","bullets":["Market"]}]}'

Options:
  --title         Deck title (required)
  --slides        JSON array of {title, bullets[]}
  --outline-file  Markdown outline: each "# Heading" starts a slide, "-"/"*" lines are its bullets
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
TITLE=""; SLIDES=""; OUTLINE_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)        [ $# -ge 2 ] || error_exit "--title requires a value";        TITLE="$2";        shift 2 ;;
    --slides)       [ $# -ge 2 ] || error_exit "--slides requires a value";       SLIDES="$2";       shift 2 ;;
    --outline-file) [ $# -ge 2 ] || error_exit "--outline-file requires a value"; OUTLINE_FILE="$2"; shift 2 ;;
    --help|-h)      print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TITLE" ]  && TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
  [ -z "$SLIDES" ] && SLIDES=$(printf '%s' "$INPUT" | jq -c '.slides // empty')
fi
if [ -n "$OUTLINE_FILE" ]; then
  [ -f "$OUTLINE_FILE" ] || error_exit "outline file not found: $OUTLINE_FILE"
  SLIDES=$(python3 - "$OUTLINE_FILE" <<'PY'
import json, re, sys
slides = []
for raw in open(sys.argv[1], encoding='utf-8'):
    line = raw.rstrip('\n')
    if re.match(r'^#{1,6}\s+', line):
        slides.append({'title': re.sub(r'^#{1,6}\s+', '', line).strip(), 'bullets': []})
    elif re.match(r'^\s*[-*]\s+', line) and slides:
        slides[-1]['bullets'].append(re.sub(r'^\s*[-*]\s+', '', line).strip())
    elif line.strip() and slides:
        slides[-1]['bullets'].append(line.strip())
print(json.dumps(slides, ensure_ascii=False))
PY
)
fi
require_param "title (--title)" "$TITLE"
require_param "slides (--slides or --outline-file)" "$SLIDES"
printf '%s' "$SLIDES" | jq -e 'type == "array" and length > 0 and all(.[]; type == "object")' >/dev/null 2>&1 || error_exit "--slides must be a non-empty JSON array of {title, bullets[]}"
BODY=$(jq -cn --arg title "$TITLE" --argjson slides "$SLIDES" '{title: $title, slides: $slides}')
RESPONSE=$(call POST "/google/slides" "$BODY") || { printf '%s\n' "$RESPONSE"; exit 1; }
printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), id: .data.id, title: .data.title, slideCount: .data.slideCount, webViewLink: .data.webViewLink}'
