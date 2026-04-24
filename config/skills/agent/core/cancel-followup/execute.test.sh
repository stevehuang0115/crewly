#!/bin/bash
# Validation tests for cancel-followup skill.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${test_name}"
    echo "    expected to contain: ${needle}"
    echo "    got: ${haystack}"
  fi
}

echo "=== cancel-followup tests ==="

echo ""
echo "--- Required args ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" 2>&1) || true
assert_contains "Empty args rejected" "One of --id or --name" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '{}' 2>&1) || true
assert_contains "Empty JSON rejected" "One of --id or --name" "$OUTPUT"

echo ""
echo "--- Help ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --help 2>&1) || true
assert_contains "Help lists --id" -- "--id" "$OUTPUT"
assert_contains "Help lists --name" -- "--name" "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
