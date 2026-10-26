#!/bin/bash
# =============================================================================
# checkup-report — the report step of the small-business check-up
# (crewly#1062): copy the bundled report App into the project for publish-app,
# turn checkup-analyse's breaks.json into the App's report document, and
# write daily-summary documents for app-data.
#
# Usage:
#   bash execute.sh --app-dir ./checkup-app                                        # copy the App page
#   bash execute.sh --breaks …/analysis/breaks.json --business "Oak Pottery" --intake ./intake.json --out ./checkup-data
#   bash execute.sh --daily "Replied to 3 open inquiries; 1 booked." --out ./checkup-data
#   bash execute.sh '{"breaks":"…/breaks.json","business":"Oak Pottery","out":"./checkup-data"}'
#
# Output: one JSON line with the files written and the exact next command
# (publish-app or app-data). Exit 0 = done, 2 = an input could not be read, 1 = usage.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="${SCRIPT_DIR}/report.mjs"

command -v node >/dev/null 2>&1 || { printf '{"success":false,"error":"node is required but not on PATH"}\n'; exit 1; }

ARGS=()
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  command -v jq >/dev/null 2>&1 || { printf '{"success":false,"error":"jq is required to read JSON input"}\n'; exit 1; }
  for key in appDir breaks business intake examples out daily date; do
    v=$(printf '%s' "$1" | jq -r --arg k "$key" '.[$k] // empty')
    if [ -n "$v" ]; then
      case "$key" in appDir) flag=--app-dir ;; *) flag="--$key" ;; esac
      ARGS+=("$flag" "$v")
    fi
  done
  shift
fi
ARGS+=("$@")

exec node "$REPORT" ${ARGS[@]+"${ARGS[@]}"}
