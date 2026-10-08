#!/bin/bash
# =============================================================================
# find-app-template — search the Crewly Marketplace for a Crewly App template.
#
# Backed by GET /api/apps/templates (the backend asks Crewly Cloud,
# crewly-services apps/SPEC.md §17.5). specs/2026-10-08-app-templates.md
#
# Usage:
#   bash execute.sh --query "chore chart for kids" [--tag kids] [--category family] [--limit 5]
#   bash execute.sh '{"query":"…","limit":5}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --query "chore chart for kids" [--tag kids] [--category family] [--limit 5]
  bash execute.sh '{"query":"…","tag":"…","category":"…","limit":5}'

Options:
  --query | -q   What the app should do, in plain words (required)
  --tag          Only templates with this tag
  --category     productivity | tracker | checklist | forms | education | family | health | finance | events | games | business | other
  --limit        Maximum results, 1-20 (default 5)
  --help  | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""; QUERY=""; TAG=""; CATEGORY=""; LIMIT=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query|-q) [ $# -ge 2 ] || error_exit "--query requires a value"; QUERY="$2"; shift 2 ;;
    --tag)      [ $# -ge 2 ] || error_exit "--tag requires a value"; TAG="$2"; shift 2 ;;
    --category) [ $# -ge 2 ] || error_exit "--category requires a value"; CATEGORY="$2"; shift 2 ;;
    --limit)    [ $# -ge 2 ] || error_exit "--limit requires a value"; LIMIT="$2"; shift 2 ;;
    --help|-h)  print_usage; exit 0 ;;
    *) if [ -z "$QUERY" ] && [ "${1:0:1}" != "-" ]; then QUERY="$1"; shift; else error_exit "Unknown option: $1"; fi ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$QUERY" ] && QUERY=$(printf '%s' "$INPUT" | jq -r '.query // empty')
  [ -z "$TAG" ] && TAG=$(printf '%s' "$INPUT" | jq -r '.tag // empty')
  [ -z "$CATEGORY" ] && CATEGORY=$(printf '%s' "$INPUT" | jq -r '.category // empty')
  [ -z "$LIMIT" ] && LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // empty')
fi
require_param "query (--query)" "$QUERY"
[ -z "$LIMIT" ] || [[ "$LIMIT" =~ ^[0-9]+$ ]] || error_exit "--limit must be a number"
[ -z "$TAG" ] || [[ "$TAG" =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]] || error_exit "--tag is one lower-case word (a-z, 0-9, -)"

uri() { printf '%s' "$1" | jq -sRr @uri; }
ENDPOINT="/apps/templates?q=$(uri "$QUERY")&limit=${LIMIT:-5}"
[ -n "$TAG" ] && ENDPOINT="${ENDPOINT}&tag=$(uri "$TAG")"
[ -n "$CATEGORY" ] && ENDPOINT="${ENDPOINT}&category=$(uri "$CATEGORY")"

ERR_FILE=$(mktemp); trap 'rm -f "$ERR_FILE"' EXIT
RESPONSE=$(api_call GET "$ENDPOINT" 2>"$ERR_FILE") || {
  ERR=$(tail -n 1 "$ERR_FILE")
  printf '%s' "$ERR" | jq -c '{success: false, reason: (.details.error // .error // "find failed"), message: (.details.message // .message // "")}' 2>/dev/null \
    || jq -cn --arg e "$ERR" '{success: false, reason: $e}'
  exit 1
}

printf '%s' "$RESPONSE" | jq -c --arg q "$QUERY" '.data as $d | {success: true, query: $q, total: ($d.total // 0),
  next: (if (($d.templates // []) | length) > 0
    then "Look at the best match (previewUrl). If it fits, run use-app-template " + $d.templates[0].templateId + " --dir ./<dir> and adapt it; tell the owner in one line which template you started from. If none fits, build the app with publish-app."
    else "No template matches. Build the app yourself with publish-app." end),
  templates: [($d.templates // [])[] | {templateId, name, description: (.description // "" | .[0:300]), category, tags, author, installs, version, capabilities, previewUrl}]}'
