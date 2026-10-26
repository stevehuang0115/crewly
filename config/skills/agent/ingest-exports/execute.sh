#!/bin/bash
# =============================================================================
# ingest-exports — load CSV exports from small-business tools (Square,
# QuickBooks, Mailchimp, Jotform, Jackrabbit, Mindbody, Calendly, Stripe)
# into one common schema for the small-business check-up (crewly#1061).
#
# Usage:
#   bash execute.sh --in ~/Downloads/exports --out /tmp/checkup            # every .csv in the folder
#   bash execute.sh --in square.csv --in invoices.csv --out /tmp/checkup --hash-names
#   bash execute.sh --in exports/ --detect-only                            # say what each file is, write nothing
#   bash execute.sh '{"in":["exports/"],"out":"/tmp/checkup","hashNames":true}'
#
# Output: one JSON line (per-file source, kind, rows, date range, unmapped
# columns, notes) and, with --out, <name>.json per file + summary.json.
# Exit 0 = every file loaded, 2 = some file could not be read, 1 = usage.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INGEST="${SCRIPT_DIR}/ingest.mjs"

command -v node >/dev/null 2>&1 || { printf '{"success":false,"error":"node is required but not on PATH"}\n'; exit 1; }

ARGS=()
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  command -v jq >/dev/null 2>&1 || { printf '{"success":false,"error":"jq is required to read JSON input"}\n'; exit 1; }
  while IFS= read -r p; do [ -n "$p" ] && ARGS+=(--in "$p"); done < <(printf '%s' "$1" | jq -r '(.in // .inputs // []) | if type=="string" then [.] else . end | .[]')
  out=$(printf '%s' "$1" | jq -r '.out // empty'); [ -n "$out" ] && ARGS+=(--out "$out")
  src=$(printf '%s' "$1" | jq -r '.source // empty'); [ -n "$src" ] && ARGS+=(--source "$src")
  [ "$(printf '%s' "$1" | jq -r '.hashNames // false')" = "true" ] && ARGS+=(--hash-names)
  [ "$(printf '%s' "$1" | jq -r '.detectOnly // false')" = "true" ] && ARGS+=(--detect-only)
  shift
fi
ARGS+=("$@")

exec node "$INGEST" "${ARGS[@]}"
