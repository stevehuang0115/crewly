#!/bin/bash
# Validation tests for credential-manager skill.
# Covers argument handling + param validation for each action. Actions that
# reach api_call are only exercised up to the point of validation (no live
# backend calls).
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE="$SCRIPT_DIR/execute.sh"
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

echo "=== credential-manager tests ==="

echo ""
echo "--- No input / missing action ---"

OUTPUT=$(bash "$EXECUTE" 2>&1) || true
assert_contains "No input rejected with usage hint" "Usage:" "$OUTPUT"

OUTPUT=$(bash "$EXECUTE" '{}' 2>&1) || true
assert_contains "Empty JSON → missing action error" "Missing required parameter: action" "$OUTPUT"

OUTPUT=$(bash "$EXECUTE" '{"action":""}' 2>&1) || true
assert_contains "Empty action → missing action error" "Missing required parameter: action" "$OUTPUT"

echo ""
echo "--- Unknown action ---"

OUTPUT=$(bash "$EXECUTE" '{"action":"does-not-exist"}' 2>&1) || true
assert_contains "Unknown action rejected" "Unknown action" "$OUTPUT"
assert_contains "Unknown action lists valid options" "list" "$OUTPUT"

echo ""
echo "--- import-google param validation ---"

OUTPUT=$(bash "$EXECUTE" '{"action":"import-google"}' 2>&1) || true
assert_contains "import-google without name rejected" "Missing required parameter: name" "$OUTPUT"

echo ""
echo "--- complete-google-oauth param validation ---"

OUTPUT=$(bash "$EXECUTE" '{"action":"complete-google-oauth"}' 2>&1) || true
assert_contains "complete without name rejected" "Missing required parameter: name" "$OUTPUT"

OUTPUT=$(bash "$EXECUTE" '{"action":"complete-google-oauth","name":"work"}' 2>&1) || true
assert_contains "complete without credentialsJson rejected" "credentialsJson is required" "$OUTPUT"

echo ""
echo "--- add-api-key param validation ---"

OUTPUT=$(bash "$EXECUTE" '{"action":"add-api-key"}' 2>&1) || true
assert_contains "add-api-key without name rejected" "Missing required parameter: name" "$OUTPUT"

OUTPUT=$(bash "$EXECUTE" '{"action":"add-api-key","name":"x"}' 2>&1) || true
assert_contains "add-api-key without provider rejected" "Missing required parameter: provider" "$OUTPUT"

OUTPUT=$(bash "$EXECUTE" '{"action":"add-api-key","name":"x","provider":"gemini"}' 2>&1) || true
assert_contains "add-api-key without value rejected" "Missing required parameter: value" "$OUTPUT"

echo ""
echo "--- delete param validation ---"

OUTPUT=$(bash "$EXECUTE" '{"action":"delete"}' 2>&1) || true
assert_contains "delete without id rejected" "Missing required parameter: id" "$OUTPUT"

echo ""
echo "--- read-gmail param validation ---"

OUTPUT=$(bash "$EXECUTE" '{"action":"read-gmail"}' 2>&1) || true
assert_contains "read-gmail without name rejected" "Missing required parameter: name" "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
