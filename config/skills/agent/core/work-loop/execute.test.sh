#!/bin/bash
# =============================================================================
# Tests for work-loop skill
#
# Verifies parameter validation, V2/V3 hybrid flow, and output format.
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ERRORS=""

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${test_name}\n    expected to contain: ${needle}\n    actual: ${haystack}"
    echo "  ✗ ${test_name}"
    echo "    expected to contain: ${needle}"
  fi
}

echo "=== work-loop tests ==="

echo ""
echo "--- Missing parameters ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '' 2>&1) || true
assert_contains "Empty input returns usage error" "Usage" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '{"role":"developer"}' 2>&1) || true
assert_contains "Missing sessionName returns error" "sessionName" "$OUTPUT"

echo ""
echo "--- Output format (no server) ---"

# Without a running server, both V2 and V3 checks will fail gracefully
# and the script should return idle status
OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '{"sessionName":"test-agent","role":"developer"}' 2>&1) || true
# Should get either an error or idle result — not crash
assert_contains "Returns JSON output" "success" "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if [ $FAIL -gt 0 ]; then
  echo -e "\nFailures:${ERRORS}"
  exit 1
fi
