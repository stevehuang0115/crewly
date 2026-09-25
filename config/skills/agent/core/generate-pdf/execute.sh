#!/bin/bash
# =============================================================================
# generate-pdf — Markdown (or HTML) → styled PDF with CJK support.
#
# Kept for compatibility: the work is done by the `pdf-tools` skill
# (headless Chrome preferred, WeasyPrint fallback, CJK-ready stylesheet).
# Input and output shapes are unchanged:
#   bash execute.sh '{"input":"/tmp/report.md","output":"/tmp/report.pdf","title":"My Report"}'
#   → {"success":true,"pdf":"/tmp/report.pdf","size":364024,"engine":"chrome"}
# A missing dependency returns pdf-tools' `needsSetup` JSON
# (run install-skill --id pdf-tools).
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"
PDF_TOOLS="${SCRIPT_DIR}/../../pdf-tools/execute.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"input\":\"/tmp/report.md\",\"output\":\"/tmp/report.pdf\",\"title\":\"My Report\"}'"
[ -f "$PDF_TOOLS" ] || error_exit "pdf-tools skill not found at ${PDF_TOOLS}"

SRC=$(printf '%s' "$INPUT" | jq -r '.input // empty')
require_param "input" "$SRC"

REQUEST=$(printf '%s' "$INPUT" | jq -c '{action: "render", input: .input}
  + (if .output then {output: .output} else {} end)
  + (if .title then {title: .title} else {} end)
  + (if .css then {css: .css} else {} end)
  + (if .engine then {engine: .engine} else {} end)')

RESULT=$(bash "$PDF_TOOLS" "$REQUEST" </dev/null) || { printf '%s\n' "$RESULT"; exit 1; }
printf '%s' "$RESULT" | jq -c '{success, pdf, size, engine}'
