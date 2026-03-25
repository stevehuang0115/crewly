#!/bin/bash
# Run quality gate checks against the project
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"projectPath\":\"/path/to/project\"}'"

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
GATES=$(printf '%s' "$INPUT" | jq -r '.gates // empty')
SKIP_OPTIONAL=$(printf '%s' "$INPUT" | jq -r '.skipOptional // empty')

# Build body with optional fields
BODY=$(printf '%s' "$INPUT" | jq '{} +
  (if .projectPath then {projectPath: .projectPath} else {} end) +
  (if .gates then {gates: .gates} else {} end) +
  (if .skipOptional == true then {skipOptional: true} else {} end)')

api_call POST "/quality-gates/check" "$BODY"
