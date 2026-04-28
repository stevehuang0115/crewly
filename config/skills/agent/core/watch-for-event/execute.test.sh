#!/bin/bash
# Validation tests for watch-for-event skill.
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

echo "=== watch-for-event tests ==="

echo ""
echo "--- Required args ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --title "Check" 2>&1) || true
assert_contains "Missing --event-type rejected" "event-type is required" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --event-type agent:idle 2>&1) || true
assert_contains "Missing --title rejected" "title is required" "$OUTPUT"

echo ""
echo "--- Help ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --help 2>&1) || true
assert_contains "Help lists --event-type" -- "--event-type" "$OUTPUT"
assert_contains "Help lists --filter-session" -- "--filter-session" "$OUTPUT"
assert_contains "Help mentions agent:idle example" "agent:idle" "$OUTPUT"
# autonomy_v1.f1 — --source flag exposed in help
assert_contains "Help lists --source" -- "--source" "$OUTPUT"

echo ""
echo "--- --source flag (autonomy_v1.f1) ---"

# Invalid --source value rejected at the skill boundary (server-side default
# would coerce silently — the skill catches typos early).
OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --event-type agent:idle --title "X" --source bogus 2>&1) || true
assert_contains "Invalid --source rejected" "must be one of: local | remote | any" "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
