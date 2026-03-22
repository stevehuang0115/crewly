#!/bin/bash
# Tests for weekly-content-planning skill
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE="${SCRIPT_DIR}/execute.sh"
TEST_PROJECT=$(mktemp -d)
PASS=0
FAIL=0

cleanup() {
  rm -rf "$TEST_PROJECT"
}
trap cleanup EXIT

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ ${test_name}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${test_name}: expected '${expected}', got '${actual}'"
    FAIL=$((FAIL + 1))
  fi
}

assert_true() {
  local test_name="$1" value="$2"
  if [ "$value" = "true" ]; then
    echo "  ✓ ${test_name}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${test_name}: expected true, got '${value}'"
    FAIL=$((FAIL + 1))
  fi
}

assert_gte() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$actual" -ge "$expected" ] 2>/dev/null; then
    echo "  ✓ ${test_name}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${test_name}: expected >= ${expected}, got '${actual}'"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Weekly Content Planning Skill Tests ==="
echo ""

# ─────────────────────────────────────────────
# Test 1: Missing required parameters
# ─────────────────────────────────────────────
echo "Test 1: Missing required parameters"
RESULT=$(bash "$EXECUTE" '{}' 2>&1 || true)
HAS_ERROR=$(echo "$RESULT" | jq -r '.error // empty' 2>/dev/null || echo "")
assert_true "exits with error on missing params" "$([ -n "$HAS_ERROR" ] && echo true || echo false)"

# ─────────────────────────────────────────────
# Test 2: Basic generation with 2 platforms
# ─────────────────────────────────────────────
echo "Test 2: Basic generation with 2 platforms"
RESULT=$(bash "$EXECUTE" "{
  \"businessName\": \"TestCorp\",
  \"industry\": \"technology\",
  \"platforms\": [\"x\", \"linkedin\"],
  \"weekStartDate\": \"2026-03-23\",
  \"projectPath\": \"${TEST_PROJECT}\",
  \"postCount\": \"5\"
}")

assert_true "returns success" "$(echo "$RESULT" | jq -r '.success')"
assert_eq "businessName matches" "TestCorp" "$(echo "$RESULT" | jq -r '.businessName')"
assert_eq "weekStartDate matches" "2026-03-23" "$(echo "$RESULT" | jq -r '.weekStartDate')"
assert_eq "generates 5 entries" "5" "$(echo "$RESULT" | jq -r '.entryCount')"
assert_true "has calendar markdown" "$(echo "$RESULT" | jq -r '.calendar' | grep -q 'Platform' && echo true || echo false)"

# Verify entries are written to calendar.json
CALENDAR_PATH="${TEST_PROJECT}/.crewly/content/calendar.json"
assert_true "calendar file created" "$([ -f "$CALENDAR_PATH" ] && echo true || echo false)"
CALENDAR_ENTRIES=$(jq '.entries | length' "$CALENDAR_PATH")
assert_eq "calendar has 5 entries" "5" "$CALENDAR_ENTRIES"

# ─────────────────────────────────────────────
# Test 3: Single platform
# ─────────────────────────────────────────────
echo "Test 3: Single platform"
TEST_PROJECT_2=$(mktemp -d)
RESULT=$(bash "$EXECUTE" "{
  \"businessName\": \"Solo\",
  \"industry\": \"marketing\",
  \"platforms\": [\"x\"],
  \"weekStartDate\": \"2026-04-01\",
  \"projectPath\": \"${TEST_PROJECT_2}\",
  \"postCount\": \"3\"
}")

assert_true "returns success" "$(echo "$RESULT" | jq -r '.success')"
assert_eq "generates 3 entries" "3" "$(echo "$RESULT" | jq -r '.entryCount')"

# All entries should be on x platform
ALL_X=$(echo "$RESULT" | jq '[.entries[] | select(.platform == "x")] | length')
assert_eq "all entries on x platform" "3" "$ALL_X"
rm -rf "$TEST_PROJECT_2"

# ─────────────────────────────────────────────
# Test 4: Invalid platforms format
# ─────────────────────────────────────────────
echo "Test 4: Invalid platforms format"
RESULT=$(bash "$EXECUTE" '{
  "businessName": "Test",
  "industry": "tech",
  "platforms": "not-an-array",
  "weekStartDate": "2026-03-23"
}' 2>&1 || true)
HAS_ERROR=$(echo "$RESULT" | jq -r '.error // empty' 2>/dev/null || echo "")
assert_true "errors on non-array platforms" "$([ -n "$HAS_ERROR" ] && echo true || echo false)"

# ─────────────────────────────────────────────
# Test 5: Entries have correct structure
# ─────────────────────────────────────────────
echo "Test 5: Entry structure validation"
TEST_PROJECT_5=$(mktemp -d)
RESULT=$(bash "$EXECUTE" "{
  \"businessName\": \"StructTest\",
  \"industry\": \"ai\",
  \"platforms\": [\"linkedin\"],
  \"weekStartDate\": \"2026-03-23\",
  \"projectPath\": \"${TEST_PROJECT_5}\",
  \"postCount\": \"2\"
}")

FIRST_ENTRY=$(echo "$RESULT" | jq '.entries[0]')
assert_true "entry has id" "$(echo "$FIRST_ENTRY" | jq -r 'has("id")' )"
assert_true "entry has platform" "$(echo "$FIRST_ENTRY" | jq -r 'has("platform")')"
assert_true "entry has category" "$(echo "$FIRST_ENTRY" | jq -r 'has("category")')"
assert_true "entry has topic" "$(echo "$FIRST_ENTRY" | jq -r 'has("topic")')"
assert_true "entry has scheduledDate" "$(echo "$FIRST_ENTRY" | jq -r 'has("scheduledDate")')"
assert_eq "entry status is draft" "draft" "$(echo "$FIRST_ENTRY" | jq -r '.status')"
rm -rf "$TEST_PROJECT_5"

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
