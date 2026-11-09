#!/bin/bash
# =============================================================================
# checkup-analyse — the analysis step of the small-business check-up
# (crewly#1062): read what ingest-exports wrote, link people across files,
# follow inquiry → sign-up → payment → repeat and list where it breaks, with
# an hours/week and $/month estimate (formula shown) per break.
#
# Usage:
#   bash execute.sh --in /tmp/checkup/ingest --out /tmp/checkup/analysis
#   bash execute.sh --in /tmp/checkup/ingest --as-of 2026-10-31 --assume hourlyValue=40
#   bash execute.sh '{"in":"/tmp/checkup/ingest","out":"/tmp/checkup/analysis","asOf":"2026-10-31","assume":{"lapsedDays":60}}'
#
# Output: one JSON line (per-break counts and estimates, the top 3, totals,
# notes) and, with --out, breaks.json (every item) + report.md.
# Exit 0 = analysed, 2 = nothing to analyse or a file could not be read, 1 = usage.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYSE="${SCRIPT_DIR}/analyse.mjs"

command -v node >/dev/null 2>&1 || { printf '{"success":false,"error":"node is required but not on PATH"}\n'; exit 1; }

ARGS=()
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  command -v jq >/dev/null 2>&1 || { printf '{"success":false,"error":"jq is required to read JSON input"}\n'; exit 1; }
  while IFS= read -r p; do [ -n "$p" ] && ARGS+=(--in "$p"); done < <(printf '%s' "$1" | jq -r '(.in // .inputs // []) | if type=="string" then [.] else . end | .[]')
  out=$(printf '%s' "$1" | jq -r '.out // empty'); [ -n "$out" ] && ARGS+=(--out "$out")
  asof=$(printf '%s' "$1" | jq -r '.asOf // .as_of // empty'); [ -n "$asof" ] && ARGS+=(--as-of "$asof")
  while IFS= read -r kv; do [ -n "$kv" ] && ARGS+=(--assume "$kv"); done < <(printf '%s' "$1" | jq -r '(.assume // .assumptions // {}) | to_entries[] | "\(.key)=\(.value)"')
  shift
fi
ARGS+=("$@")

exec node "$ANALYSE" ${ARGS[@]+"${ARGS[@]}"}
