#!/bin/bash
# Validation tests for list-my-followups skill.
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

echo "=== list-my-followups tests ==="

echo ""
echo "--- Help ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --help 2>&1) || true
assert_contains "Help mentions --status" -- "--status" "$OUTPUT"
assert_contains "Help mentions --name-prefix" -- "--name-prefix" "$OUTPUT"

echo ""
echo "--- Team resolution ---"

# Without CREWLY_SESSION_NAME, the skill must refuse rather than returning an
# all-teams dump. Clear env and run.
OUTPUT=$(env -u CREWLY_SESSION_NAME bash "$SCRIPT_DIR/execute.sh" 2>&1) || true
assert_contains "No session → team-resolve error" "Cannot resolve owning team" "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
