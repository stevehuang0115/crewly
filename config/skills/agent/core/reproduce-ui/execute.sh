#!/bin/bash
# =============================================================================
# reproduce-ui — open a dashboard feature by its feature-map entry and save
# evidence: screenshot, console errors, failed requests, timings (#811).
#
# Drives a headless Chrome with playwright-core (a Crewly dependency) against
# the local dashboard. The feature map (frontend/FEATURE_MAP.md in a Crewly
# checkout) supplies the route and the element to wait for; without it, pass
# --route and --wait.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

# config/skills/agent/core/<skill> → the Crewly package root (repo or npm install)
PKG_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --route /tickets?tab=runs                 Open a route, wait for its key element, save evidence
  bash execute.sh --feature "Run detail" --param id=<uuid>   Resolve the route from the feature map
  bash execute.sh --report "runs tab is blank, Tickets"      Match a bug report to a feature, then run it
  bash execute.sh --route /wiki --wait '[data-testid="wiki-recent-list"]' --full-page

Options:
  --route      Path to open (with ?tab= when the page has tabs)
  --feature    A route or a word from a Routes row of FEATURE_MAP.md (needs the map)
  --report     A bug report: the owner's sentence plus the words you read on the
               screenshot; scored against the map's Features (needs the map)
  --report-file  The same, read from a file
  --param k=v  Value for a :param in the route (repeatable)
  --wait       CSS selector to wait for (default: the feature's first data-testid, else body)
  --map        FEATURE_MAP.md path (default: <project>/frontend/FEATURE_MAP.md when present)
  --base-url   Dashboard origin (default: CREWLY_API_URL)
  --out        Evidence root (default: $CREWLY_HOME/evidence)
  --timeout    Milliseconds to wait for navigation and for the element (default 60000)
  --full-page  Full-page screenshot
  --browser    Chrome/Chromium executable (default: the installed Google Chrome)
  --dry-run    Print the resolved plan, open nothing
  --help | -h  Show this help

Output: one JSON line with the evidence folder (screenshot.png, console.json,
requests.json, report.md, summary.json; summary.ticketLine is the line to put
in the ticket). Exit 0 when the element appeared, 2 when it did not (evidence
still saved), 1 on a usage or browser error, 3 when the report matches no
single feature (candidates on stderr; pass --route).
EOF_USAGE
}

ROUTE=""; FEATURE=""; REPORT=""; WAIT=""; MAP=""; BASE_URL=""; OUT=""; TIMEOUT=""; FULL_PAGE=""; BROWSER=""; DRY_RUN=""
PARAMS=()

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  ROUTE=$(printf '%s' "$1" | jq -r '.route // empty')
  FEATURE=$(printf '%s' "$1" | jq -r '.feature // empty')
  REPORT=$(printf '%s' "$1" | jq -r '.report // empty')
  WAIT=$(printf '%s' "$1" | jq -r '.wait // empty')
  MAP=$(printf '%s' "$1" | jq -r '.map // empty')
  BASE_URL=$(printf '%s' "$1" | jq -r '.baseUrl // empty')
  OUT=$(printf '%s' "$1" | jq -r '.out // empty')
  TIMEOUT=$(printf '%s' "$1" | jq -r '.timeout // empty')
  FULL_PAGE=$(printf '%s' "$1" | jq -r 'if .fullPage == true then "1" else empty end')
  DRY_RUN=$(printf '%s' "$1" | jq -r 'if .dryRun == true then "1" else empty end')
  while IFS= read -r kv; do [ -n "$kv" ] && PARAMS+=("$kv"); done < <(printf '%s' "$1" | jq -r '(.params // {}) | to_entries[] | "\(.key)=\(.value)"')
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --route)     [ $# -ge 2 ] || error_exit "--route requires a value";    ROUTE="$2";    shift 2 ;;
    --feature)   [ $# -ge 2 ] || error_exit "--feature requires a value";  FEATURE="$2";  shift 2 ;;
    --report)    [ $# -ge 2 ] || error_exit "--report requires text";      REPORT="$2";   shift 2 ;;
    --report-file) [ $# -ge 2 ] || error_exit "--report-file requires a path"; [ -f "$2" ] || error_exit "--report-file not found: $2"; REPORT="$(cat "$2")"; shift 2 ;;
    --param)     [ $# -ge 2 ] || error_exit "--param requires k=v";        PARAMS+=("$2"); shift 2 ;;
    --wait)      [ $# -ge 2 ] || error_exit "--wait requires a selector";  WAIT="$2";     shift 2 ;;
    --map)       [ $# -ge 2 ] || error_exit "--map requires a path";       MAP="$2";      shift 2 ;;
    --base-url)  [ $# -ge 2 ] || error_exit "--base-url requires a value"; BASE_URL="$2"; shift 2 ;;
    --out)       [ $# -ge 2 ] || error_exit "--out requires a path";       OUT="$2";      shift 2 ;;
    --timeout)   [ $# -ge 2 ] || error_exit "--timeout requires ms";       TIMEOUT="$2";  shift 2 ;;
    --browser)   [ $# -ge 2 ] || error_exit "--browser requires a path";   BROWSER="$2";  shift 2 ;;
    --full-page) FULL_PAGE="1"; shift ;;
    --dry-run)   DRY_RUN="1"; shift ;;
    --help|-h)   print_usage; exit 0 ;;
    *) unknown_arg_exit "$1" ;;
  esac
done

[ -n "$ROUTE" ] || [ -n "$FEATURE" ] || [ -n "$REPORT" ] || error_exit "one of --route, --feature or --report is required (--help for usage)"
command -v node >/dev/null 2>&1 || error_exit "node is required"

# The map: explicit, else the project's checkout, else the package's own copy (a repo install).
if [ -z "$MAP" ]; then
  for cand in "${CREWLY_PROJECT_PATH:-$PWD}/frontend/FEATURE_MAP.md" "${PKG_ROOT}/frontend/FEATURE_MAP.md"; do
    if [ -f "$cand" ]; then MAP="$cand"; break; fi
  done
fi

for kv in "${PARAMS[@]+"${PARAMS[@]}"}"; do
  [[ "$kv" == *=* ]] || error_exit "--param needs k=v, got: $kv"
  key="${kv%%=*}"; val="${kv#*=}"
  [[ "$key" =~ ^[A-Za-z_]+$ ]] || error_exit "--param name must be a word: $key"
  export "RU_PARAM_${key}=${val}"
done

RU_MAIN=1 RU_ROUTE="$ROUTE" RU_FEATURE="$FEATURE" RU_REPORT="$REPORT" RU_WAIT="$WAIT" RU_MAP="$MAP" RU_BASE_URL="$BASE_URL" \
RU_OUT="$OUT" RU_TIMEOUT_MS="$TIMEOUT" RU_FULL_PAGE="$FULL_PAGE" RU_BROWSER="$BROWSER" RU_DRY_RUN="$DRY_RUN" \
RU_PKG_ROOT="$PKG_ROOT" node "${SCRIPT_DIR}/reproduce.mjs"
