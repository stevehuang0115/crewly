#!/bin/bash
# List all active scheduled checks with optional session filter
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")

# Optional session filter
SESSION=""
if [ -n "$INPUT" ]; then
  SESSION=$(printf '%s' "$INPUT" | jq -r '.session // empty')
fi

if [ -n "$SESSION" ]; then
  api_call GET "/schedule?session=${SESSION}"
else
  api_call GET "/schedule"
fi
