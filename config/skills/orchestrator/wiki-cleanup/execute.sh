#!/bin/bash
# wiki-cleanup — detect + remove low-quality pages from a wiki vault.
#
# Two modes:
#   scan   (default) — dry-run. Returns the list of cleanup candidates
#                      with their reasons (low confidence / agent
#                      memory dump / per-agent cap). No filesystem writes.
#   apply             — delete the listed pages, archive each body +
#                       frontmatter to <vault>/.wiki-cleanup-archive.json,
#                       and invalidate matching migrate-manifest entries
#                       so the same source can't re-import the page.
#
# Safety:
#   - LEGACY FILES are never touched (memory.json, .crewly/knowledge/*).
#   - Frozen folders (memory/, sop/, sop-overrides/, okr/) are not scanned.
#   - apply requires an explicit `--pages` list — the caller (usually an
#     agent in the loop) decides which scan candidates to actually delete.
#
# Usage:
#   bash execute.sh --vault /abs/vault                                # scan with defaults
#   bash execute.sh --vault /abs/vault --min-confidence 0.4           # scan with custom rule
#   bash execute.sh --vault /abs/vault --apply --pages "a.md,b.md"    # delete the two listed pages
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
VAULT=""
APPLY="false"
PAGES_CSV=""
MIN_CONFIDENCE=""
DROP_AGENT_MEMORY=""
MAX_PER_AGENT=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"; shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v)          VAULT="$2"; shift 2 ;;
    --apply|-a)          APPLY="true"; shift ;;
    --pages|-p)          PAGES_CSV="$2"; shift 2 ;;
    --min-confidence)    MIN_CONFIDENCE="$2"; shift 2 ;;
    --no-drop-agent-memory)
                         DROP_AGENT_MEMORY="false"; shift ;;
    --max-per-agent)     MAX_PER_AGENT="$2"; shift 2 ;;
    --json|-j)           INPUT_JSON="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage:
  execute.sh --vault <abs path>                                  # scan (dry-run)
  execute.sh --vault <abs path> --min-confidence 0.4             # scan with custom threshold
  execute.sh --vault <abs path> --apply --pages "X.md,Y.md"      # delete listed pages

Scan rules (applied independently — any match flags the page):
  --min-confidence FLOAT      Pages with frontmatter confidence < FLOAT
                              (default 0.5).
  --no-drop-agent-memory      Disable the "drop pages migrated_from:
                              agent/<id>/memory.json" rule (default ON).
  --max-per-agent INT         Keep top-N (by confidence desc, date desc)
                              per original_author. Default 0 = disabled.

Apply:
  --apply                     Execute deletes (requires --pages).
  --pages "X.md,Y.md"         Comma-separated relative paths to delete.
                              Each MUST be under the vault. Paths under
                              frozen folders (memory/, sop/, ...) are
                              refused even with --apply.

Outputs a JSON report:
  scan:  { candidates: [...], scannedCount, summary, truncated }
  apply: { deleted: [...], skipped: [...], archivePath, manifestEntriesInvalidated }

Re-runs are safe — apply is idempotent (a missing file is "skipped").
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
  [ -z "$VAULT" ] && VAULT=$(printf '%s' "$INPUT" | jq -r '.vaultPath // empty')
  if printf '%s' "$INPUT" | jq -e '.apply == true' >/dev/null 2>&1; then APPLY="true"; fi
  if [ -z "$PAGES_CSV" ]; then
    JSON_PAGES=$(printf '%s' "$INPUT" | jq -r '.pages // [] | join(",")')
    [ -n "$JSON_PAGES" ] && PAGES_CSV="$JSON_PAGES"
  fi
  if [ -z "$MIN_CONFIDENCE" ]; then
    MIN_CONFIDENCE=$(printf '%s' "$INPUT" | jq -r '.rules.minConfidence // empty')
  fi
  if [ -z "$MAX_PER_AGENT" ]; then
    MAX_PER_AGENT=$(printf '%s' "$INPUT" | jq -r '.rules.maxPerAgent // empty')
  fi
fi

require_param "vaultPath (--vault)" "$VAULT"

export _WC_V="$VAULT"

if [ "$APPLY" = "true" ]; then
  if [ -z "$PAGES_CSV" ]; then
    error_exit "--apply requires --pages with at least one relative path"
  fi
  # Convert CSV → JSON array of trimmed strings.
  export _WC_PAGES="$PAGES_CSV"
  BODY=$(jq -n '{
    vaultPath: env._WC_V,
    pages: (env._WC_PAGES | split(",") | map(gsub("^\\s+|\\s+$"; ""))),
    confirm: true
  }')
  api_call POST "/wiki/cleanup/apply" "$BODY"
  unset _WC_PAGES
else
  # Build rules object only with keys the user actually set.
  RULES_JSON="{}"
  if [ -n "$MIN_CONFIDENCE" ]; then
    export _WC_MC="$MIN_CONFIDENCE"
    RULES_JSON=$(printf '%s' "$RULES_JSON" | jq '. + {minConfidence: (env._WC_MC | tonumber)}')
    unset _WC_MC
  fi
  if [ "$DROP_AGENT_MEMORY" = "false" ]; then
    RULES_JSON=$(printf '%s' "$RULES_JSON" | jq '. + {dropAgentMemoryDumps: false}')
  fi
  if [ -n "$MAX_PER_AGENT" ]; then
    export _WC_MPA="$MAX_PER_AGENT"
    RULES_JSON=$(printf '%s' "$RULES_JSON" | jq '. + {maxPerAgent: (env._WC_MPA | tonumber)}')
    unset _WC_MPA
  fi
  export _WC_RULES="$RULES_JSON"
  BODY=$(jq -n '{vaultPath: env._WC_V, rules: (env._WC_RULES | fromjson)}')
  api_call POST "/wiki/cleanup/scan" "$BODY"
  unset _WC_RULES
fi
unset _WC_V
