#!/bin/bash
# =============================================================================
# checkup-end — end a small-business check-up (crewly#1055): delete every
# file the check-up produced on this machine and write a receipt that says
# what was deleted, what was kept and what the lead still has to do
# (unpublish the App, revoke any access the owner granted).
#
# Usage:
#   bash execute.sh --dir . --business "Oak Pottery" --app <appId>            # the project the team worked in
#   bash execute.sh --dir . --exports ~/Downloads/oak-exports                  # also the raw CSVs the owner handed over
#   bash execute.sh --dir . --dry-run                                          # list what would go, delete nothing
#   bash execute.sh '{"dir":".","business":"Oak Pottery","app":"28au74d9cj","dryRun":true}'
#
# Output: one JSON line (files deleted, bytes, leftovers, receipt paths, the
# commands still to run). Exit 0 = done, 2 = not a check-up folder or a file
# would not delete, 1 = usage.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
END="${SCRIPT_DIR}/end.mjs"

command -v node >/dev/null 2>&1 || { printf '{"success":false,"error":"node is required but not on PATH"}\n'; exit 1; }

ARGS=()
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  command -v jq >/dev/null 2>&1 || { printf '{"success":false,"error":"jq is required to read JSON input"}\n'; exit 1; }
  for key in dir business app exports ingest analysis data appDir intake receipt; do
    v=$(printf '%s' "$1" | jq -r --arg k "$key" '.[$k] // empty')
    if [ -n "$v" ]; then
      case "$key" in appDir) flag=--app-dir ;; *) flag="--$key" ;; esac
      ARGS+=("$flag" "$v")
    fi
  done
  [ "$(printf '%s' "$1" | jq -r '.dryRun // false')" = "true" ] && ARGS+=(--dry-run)
  shift
fi
ARGS+=("$@")

exec node "$END" ${ARGS[@]+"${ARGS[@]}"}
