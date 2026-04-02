#!/bin/bash
# Eval skill shim: verify-output
#
# Runs a set of check commands and reports pass/fail for each.
# Used by the TL to verify a worker's deliverables.
#
# Usage:
#   bash skills/verify-output.sh '{"checks":[{"name":"build","command":"npm run build"},{"name":"tests","command":"npm test"}]}'
#
# Output: JSON with per-check results

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_log.sh"

INPUT="${1:-'{}'}"
log_tool_call "verify-output" "$INPUT"

CHECKS=$(echo "$INPUT" | jq -c '.checks // []')
RESULTS="[]"
ALL_PASSED=true

# Iterate over each check
echo "$CHECKS" | jq -c '.[]' | while IFS= read -r check; do
  NAME=$(echo "$check" | jq -r '.name')
  COMMAND=$(echo "$check" | jq -r '.command')

  if eval "$COMMAND" > /tmp/eval-verify-$$.log 2>&1; then
    PASSED=true
  else
    PASSED=false
    ALL_PASSED=false
  fi

  OUTPUT=$(cat /tmp/eval-verify-$$.log 2>/dev/null | tail -5 | jq -Rs .)
  rm -f /tmp/eval-verify-$$.log

  echo "{\"name\":\"$NAME\",\"passed\":$PASSED,\"output\":$OUTPUT}"
done | jq -s '{success: true, allPassed: (map(.passed) | all), results: .}'
