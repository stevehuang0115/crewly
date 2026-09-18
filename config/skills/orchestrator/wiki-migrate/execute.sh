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
# Output is a COMPACT report by default (counts by sourceType, alreadyMigrated
# vs netNew, first few net-new target paths). The raw backend payload carries
# the full `proposedPages` array — hundreds of rows — and is only returned
# with --full.
#
# Usage:
#   bash execute.sh --project-root /abs/path                       # scan (compact)
#   bash execute.sh --project-root /abs/path --full                # scan (raw proposedPages)
#   bash execute.sh --project-root /abs/path --apply               # write
#   bash execute.sh --project-root /abs/path --no-memory --apply   # skip agent memory.json copies
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

# Number of net-new target paths listed in the compact report.
WIKI_MIGRATE_SAMPLE_SIZE="${WIKI_MIGRATE_SAMPLE_SIZE:-10}"
COMPACT_FILTER="${SCRIPT_DIR}/compact.jq"

INPUT_JSON=""
PROJECT_ROOT=""
APPLY="false"
INCLUDE_MEMORY="true"
# lib.sh sets CREWLY_SKILL_FULL_OUTPUT=1 when --full is anywhere in argv.
FULL="${CREWLY_SKILL_FULL_OUTPUT:-0}"

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"; shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root|-p) PROJECT_ROOT="$2"; shift 2 ;;
    --apply|-a)        APPLY="true";     shift   ;;
    --no-memory)       INCLUDE_MEMORY="false"; shift ;;
    --full|-f)         FULL="1";         shift   ;;
    --json|-j)         INPUT_JSON="$2";  shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --project-root <abs path>            # scan (dry-run)
  execute.sh --project-root <abs path> --apply    # execute migration
  execute.sh --project-root <abs path> --no-memory --apply
                                                  # apply but skip agent memory.json copies
  execute.sh --project-root <abs path> --full     # raw payload incl. full proposedPages

Outputs a compact JSON report (default):
  - legacyDetected   : true when any legacy source exists
  - totalProposed / alreadyMigrated / netNew / skippedOther / routingUncertain
  - byCategory       : {sourceType: {proposed, netNew}}
  - netNewSample     : first ${WIKI_MIGRATE_SAMPLE_SIZE} net-new target paths
  - bootstrapNeeded  : which vaults will be bootstrapped on --apply
  - summary          : counts per source type
  - applied/skipped  : only present on --apply

With --full the raw backend payload is returned instead, including the
per-entry proposedPages array (target + skipReason when "already migrated").

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
  if printf '%s' "$INPUT" | jq -e '.full == true' >/dev/null 2>&1; then FULL="1"; fi
fi

require_param "projectRoot (--project-root)" "$PROJECT_ROOT"

export _WM_R="$PROJECT_ROOT"
export _WM_M="$INCLUDE_MEMORY"

if [ "$APPLY" = "true" ]; then
  BODY=$(jq -n '{projectRoot: env._WM_R, includeAgentMemory: (env._WM_M == "true"), confirm: true}')
  ENDPOINT="/wiki/migrate/apply"
else
  BODY=$(jq -n '{projectRoot: env._WM_R, includeAgentMemory: (env._WM_M == "true")}')
  ENDPOINT="/wiki/migrate/scan"
fi
unset _WM_R _WM_M

# Fetch the raw payload uncapped so the compact filter sees the whole array;
# the compact report is small, and --full re-enters the shared output cap.
RAW=$(CREWLY_SKILL_FULL_OUTPUT=1 api_call POST "$ENDPOINT" "$BODY")

if [ "$FULL" = "1" ]; then
  _cap_skill_output "$RAW"
else
  printf '%s' "$RAW" | jq --argjson sample "$WIKI_MIGRATE_SAMPLE_SIZE" -f "$COMPACT_FILTER"
fi
