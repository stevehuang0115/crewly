#!/usr/bin/env bash
# =============================================================================
# web-search — search the live web, return ranked results as JSON.
#
# Provider order (best → fallback):
#   1. Brave Search API   (BRAVE_API_KEY)
#   2. SerpAPI / Google   (SERPAPI_KEY)
#   3. DuckDuckGo HTML    (no key — always available)
#
# Always prints valid JSON on stdout: { query, provider, results: [...] }.
# On error, results is [] and an `error` field is set (exit 0 so callers can
# branch on JSON, not exit code — matches the other read-only agent skills).
#
# Usage:
#   bash execute.sh "your query"
#   bash execute.sh --query "your query" --limit 5
#   bash execute.sh '{"query":"...","limit":8}'
# =============================================================================
set -o pipefail

TIMEOUT=15
DEFAULT_LIMIT=8
MAX_LIMIT=20

QUERY=""
LIMIT="$DEFAULT_LIMIT"

# --- Parse args: --query/--limit flags, OR a JSON object, OR positional. -----
parse_json_arg() {
  # $1 is a JSON string; extract .query and .limit if jq is available.
  if command -v jq >/dev/null 2>&1; then
    local q l
    q="$(printf '%s' "$1" | jq -r '.query // empty' 2>/dev/null || true)"
    l="$(printf '%s' "$1" | jq -r '.limit // empty' 2>/dev/null || true)"
    [ -n "$q" ] && QUERY="$q"
    [ -n "$l" ] && LIMIT="$l"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --query) QUERY="${2:-}"; shift 2 ;;
    --limit) LIMIT="${2:-$DEFAULT_LIMIT}"; shift 2 ;;
    --query=*) QUERY="${1#--query=}"; shift ;;
    --limit=*) LIMIT="${1#--limit=}"; shift ;;
    \{*) parse_json_arg "$1"; shift ;;
    *) [ -z "$QUERY" ] && QUERY="$1"; shift ;;
  esac
done

# --- Helpers -----------------------------------------------------------------
json_escape() {
  # Escape a string for embedding in JSON (no jq dependency for output).
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs .
  else
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/ /g' | tr -d '\r\n')"
  fi
}

emit_error() {
  printf '{"query":%s,"provider":"none","results":[],"error":%s}\n' \
    "$(json_escape "$QUERY")" "$(json_escape "$1")"
  exit 0
}

# Cap the limit.
case "$LIMIT" in
  ''|*[!0-9]*) LIMIT="$DEFAULT_LIMIT" ;;
esac
[ "$LIMIT" -gt "$MAX_LIMIT" ] && LIMIT="$MAX_LIMIT"
[ "$LIMIT" -lt 1 ] && LIMIT="$DEFAULT_LIMIT"

[ -z "$QUERY" ] && emit_error "missing query — pass it positionally, via --query, or JSON {\"query\":...}"
command -v curl >/dev/null 2>&1 || emit_error "curl not available"

# URL-encode the query.
urlencode() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -sRr @uri
  else
    local s="$1" out="" c i
    for (( i=0; i<${#s}; i++ )); do
      c="${s:$i:1}"
      case "$c" in
        [a-zA-Z0-9.~_-]) out+="$c" ;;
        *) out+=$(printf '%%%02X' "'$c") ;;
      esac
    done
    printf '%s' "$out"
  fi
}
Q_ENC="$(urlencode "$QUERY")"

# --- Provider 1: Brave Search API -------------------------------------------
if [ -n "${BRAVE_API_KEY:-}" ] && command -v jq >/dev/null 2>&1; then
  RESP="$(curl -sS --max-time "$TIMEOUT" \
    -H "Accept: application/json" \
    -H "X-Subscription-Token: ${BRAVE_API_KEY}" \
    "https://api.search.brave.com/res/v1/web/search?q=${Q_ENC}&count=${LIMIT}" 2>/dev/null || true)"
  if [ -n "$RESP" ]; then
    OUT="$(printf '%s' "$RESP" | jq -c --arg q "$QUERY" \
      '{query:$q, provider:"brave",
        results: [ (.web.results // [])[] | {title:.title, url:.url, snippet:(.description // "")} ]}' \
      2>/dev/null || true)"
    if [ -n "$OUT" ] && printf '%s' "$OUT" | jq -e '.results | length >= 0' >/dev/null 2>&1; then
      printf '%s\n' "$OUT"; exit 0
    fi
  fi
fi

# --- Provider 2: SerpAPI (Google) -------------------------------------------
if [ -n "${SERPAPI_KEY:-}" ] && command -v jq >/dev/null 2>&1; then
  RESP="$(curl -sS --max-time "$TIMEOUT" \
    "https://serpapi.com/search.json?engine=google&num=${LIMIT}&q=${Q_ENC}&api_key=${SERPAPI_KEY}" 2>/dev/null || true)"
  if [ -n "$RESP" ]; then
    OUT="$(printf '%s' "$RESP" | jq -c --arg q "$QUERY" \
      '{query:$q, provider:"serpapi",
        results: [ (.organic_results // [])[] | {title:.title, url:.link, snippet:(.snippet // "")} ]}' \
      2>/dev/null || true)"
    if [ -n "$OUT" ] && printf '%s' "$OUT" | jq -e '.results | length >= 0' >/dev/null 2>&1; then
      printf '%s\n' "$OUT"; exit 0
    fi
  fi
fi

# --- Provider 3: DuckDuckGo HTML (no key) -----------------------------------
# Best-effort scrape of result titles + URLs from the lite/HTML endpoint.
HTML="$(curl -sS --max-time "$TIMEOUT" -A "Mozilla/5.0 (compatible; crewly-web-search/1.0)" \
  "https://html.duckduckgo.com/html/?q=${Q_ENC}" 2>/dev/null || true)"
if [ -z "$HTML" ]; then
  emit_error "all providers failed (no network or blocked)"
fi

# Extract result anchors: class="result__a" href="<url>">title</a>. The loop
# runs in the MAIN shell via process substitution so it can append to a var
# (and so a `case`/`)` never lands inside a $() command substitution).
ITEMS=""
append_item() {
  # $1=title $2=url — append one JSON object to ITEMS (comma-separated).
  local obj
  if command -v jq >/dev/null 2>&1; then
    obj="$(jq -cn --arg t "$1" --arg u "$2" '{title:$t, url:$u, snippet:""}')"
  else
    obj="$(printf '{"title":%s,"url":%s,"snippet":""}' "$(json_escape "$1")" "$(json_escape "$2")")"
  fi
  ITEMS="${ITEMS}${ITEMS:+,}${obj}"
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  href="$(printf '%s' "$line" | sed -E 's/.*href="([^"]*)".*/\1/')"
  title="$(printf '%s' "$line" | sed -E 's/.*>([^<]*)<\/a>/\1/')"
  # Decode DDG redirect (uddg=<encoded>) when present.
  if [[ "$href" == *uddg=* ]]; then
    enc="$(printf '%s' "$href" | sed -E 's/.*uddg=([^&]*).*/\1/')"
    if command -v python3 >/dev/null 2>&1; then
      href="$(python3 -c "import sys,urllib.parse;print(urllib.parse.unquote(sys.argv[1]))" "$enc" 2>/dev/null || printf '%s' "$href")"
    fi
  fi
  # HTML-unescape a few common entities in the title.
  title="$(printf '%s' "$title" | sed 's/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g; s/&#x27;/'"'"'/g; s/&quot;/"/g')"
  [ -z "$title" ] && continue
  append_item "$title" "$href"
done < <(printf '%s' "$HTML" \
  | grep -oE '<a[^>]*class="result__a"[^>]*href="[^"]*"[^>]*>[^<]*</a>' \
  | head -n "$LIMIT")

printf '{"query":%s,"provider":"duckduckgo","results":[%s]}\n' "$(json_escape "$QUERY")" "$ITEMS"
exit 0
