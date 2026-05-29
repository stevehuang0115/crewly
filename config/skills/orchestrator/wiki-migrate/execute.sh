#!/bin/bash
# wiki-migrate — one-shot conversion of legacy `.crewly/knowledge/*.json` +
# loose .md + agent memory.json into the v2.1 three-scope vault structure.
#
# Two modes:
#   scan   (default) — dry-run preview. Returns proposed pages with
#                      target paths, no writes.
#   apply             — execute the migration. Bootstraps missing vaults,
#                       writes pages, records a manifest. LEGACY FILES
#                       ARE NEVER DELETED.
#
# Safe to re-run. The manifest at <project>/.crewly/wiki/.migration-state.json
# tracks already-migrated entries by content hash + sourceId.
#
# Usage:
#   bash execute.sh --project-root /abs/path                       # scan
#   bash execute.sh --project-root /abs/path --apply               # write
#   bash execute.sh --project-root /abs/path --no-memory --apply   # skip agent memory.json copies
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
PROJECT_ROOT=""
APPLY="false"
INCLUDE_MEMORY="true"

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"; shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root|-p) PROJECT_ROOT="$2"; shift 2 ;;
    --apply|-a)        APPLY="true";     shift   ;;
    --no-memory)       INCLUDE_MEMORY="false"; shift ;;
    --json|-j)         INPUT_JSON="$2";  shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --project-root <abs path>            # scan (dry-run)
  execute.sh --project-root <abs path> --apply    # execute migration
  execute.sh --project-root <abs path> --no-memory --apply
                                                  # apply but skip agent memory.json copies

Outputs a JSON report:
  - legacyDetected   : true when any legacy source exists
  - proposedPages    : per-entry target + skipReason (when "already migrated")
  - bootstrapNeeded  : which vaults will be bootstrapped on --apply
  - summary          : counts per source type
  - applied/skipped  : only present on --apply

The skill makes NO LLM calls. Re-running is safe (idempotent via manifest).
EOF
      exit 0 ;;
    --) shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift
      else error_exit "Unknown argument: $1"; fi ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$PROJECT_ROOT" ] && PROJECT_ROOT=$(printf '%s' "$INPUT" | jq -r '.projectRoot       // empty')
  if printf '%s' "$INPUT" | jq -e '.apply == true' >/dev/null 2>&1; then APPLY="true"; fi
  if printf '%s' "$INPUT" | jq -e '.includeAgentMemory == false' >/dev/null 2>&1; then INCLUDE_MEMORY="false"; fi
fi

require_param "projectRoot (--project-root)" "$PROJECT_ROOT"

export _WM_R="$PROJECT_ROOT"
export _WM_M="$INCLUDE_MEMORY"

if [ "$APPLY" = "true" ]; then
  BODY=$(jq -n '{projectRoot: env._WM_R, includeAgentMemory: (env._WM_M == "true"), confirm: true}')
  api_call POST "/wiki/migrate/apply" "$BODY"
else
  BODY=$(jq -n '{projectRoot: env._WM_R, includeAgentMemory: (env._WM_M == "true")}')
  api_call POST "/wiki/migrate/scan" "$BODY"
fi
unset _WM_R _WM_M
