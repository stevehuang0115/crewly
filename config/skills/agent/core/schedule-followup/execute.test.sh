#!/bin/bash
# Validation tests for schedule-followup skill.
# End-to-end behaviour (actually POSTing to /api/triggers) is verified by the
# backend integration tests; here we cover argument parsing + guard rails.
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

echo "=== schedule-followup tests ==="

echo ""
echo "--- Required args ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --in-minutes 30 2>&1) || true
assert_contains "Missing --title rejected" "title is required" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --title "Check Rex" 2>&1) || true
assert_contains "No timing spec rejected" "one of --in-minutes" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --title "Check" --in-minutes 30 --fire-at "2026-01-01T00:00:00Z" 2>&1) || true
assert_contains "Conflicting timing specs rejected" "one of --in-minutes" "$OUTPUT"

echo ""
echo "--- Help ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --help 2>&1) || true
assert_contains "Help lists --in-minutes" -- "--in-minutes" "$OUTPUT"
assert_contains "Help lists --fire-at" -- "--fire-at" "$OUTPUT"
assert_contains "Help lists --cron" -- "--cron" "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
