#!/bin/bash
# Tests for weekly-marketing-report skill
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

echo "=== Weekly Marketing Report Skill Tests ==="
echo ""

# ─────────────────────────────────────────────
# Test 1: Missing required parameters
# ─────────────────────────────────────────────
echo "Test 1: Missing required parameters"
RESULT=$(bash "$EXECUTE" '{}' 2>&1 || true)
HAS_ERROR=$(echo "$RESULT" | jq -r '.error // empty' 2>/dev/null || echo "")
assert_true "exits with error on missing params" "$([ -n "$HAS_ERROR" ] && echo true || echo false)"

# ─────────────────────────────────────────────
# Test 2: Empty calendar (no file)
# ─────────────────────────────────────────────
echo "Test 2: No calendar file"
EMPTY_PROJECT=$(mktemp -d)
RESULT=$(bash "$EXECUTE" "{
  \"projectPath\": \"${EMPTY_PROJECT}\",
  \"weekEndDate\": \"2026-03-29\",
  \"businessName\": \"EmptyBiz\"
}")

assert_true "returns success" "$(echo "$RESULT" | jq -r '.success')"
assert_eq "totalPosts is 0" "0" "$(echo "$RESULT" | jq -r '.report.totalPosts')"
assert_true "has recommendations" "$(echo "$RESULT" | jq -r '.report.recommendations | length > 0')"
assert_true "has markdown" "$(echo "$RESULT" | jq -r '.markdown' | grep -q 'Weekly Marketing Report' && echo true || echo false)"
rm -rf "$EMPTY_PROJECT"

# ─────────────────────────────────────────────
# Test 3: Calendar with sample data
# ─────────────────────────────────────────────
echo "Test 3: Calendar with sample data"
CALENDAR_DIR="${TEST_PROJECT}/.crewly/content"
mkdir -p "$CALENDAR_DIR"
cat > "${CALENDAR_DIR}/calendar.json" << 'CALEOF'
{
  "entries": [
    {
      "id": "cc-test-001",
      "title": "AI Trends Thread",
      "platform": "x",
      "type": "thread",
      "scheduledDate": "2026-03-23",
      "status": "published",
      "publishedAt": "2026-03-23T10:00:00Z",
      "line": "crewly",
      "topic": "AI trends",
      "notes": "",
      "tags": ["ai"],
      "createdAt": "2026-03-22T00:00:00Z",
      "updatedAt": "2026-03-23T10:00:00Z"
    },
    {
      "id": "cc-test-002",
      "title": "LinkedIn Thought Leadership",
      "platform": "linkedin",
      "type": "post",
      "scheduledDate": "2026-03-24",
      "status": "published",
      "publishedAt": "2026-03-24T09:00:00Z",
      "line": "crewly",
      "topic": "Leadership",
      "notes": "",
      "tags": ["leadership"],
      "createdAt": "2026-03-22T00:00:00Z",
      "updatedAt": "2026-03-24T09:00:00Z"
    },
    {
      "id": "cc-test-003",
      "title": "Product Update Post",
      "platform": "x",
      "type": "post",
      "scheduledDate": "2026-03-25",
      "status": "draft",
      "line": "crewly",
      "topic": "Product update",
      "notes": "",
      "tags": ["product"],
      "createdAt": "2026-03-22T00:00:00Z",
      "updatedAt": "2026-03-22T00:00:00Z"
    },
    {
      "id": "cc-test-004",
      "title": "Community Question",
      "platform": "linkedin",
      "type": "post",
      "scheduledDate": "2026-03-26",
      "status": "ready",
      "line": "crewly",
      "topic": "Community",
      "notes": "",
      "tags": ["community"],
      "createdAt": "2026-03-22T00:00:00Z",
      "updatedAt": "2026-03-22T00:00:00Z"
    },
    {
      "id": "cc-test-old",
      "title": "Old Post (outside week)",
      "platform": "x",
      "type": "post",
      "scheduledDate": "2026-03-10",
      "status": "published",
      "publishedAt": "2026-03-10T10:00:00Z",
      "line": "crewly",
      "topic": "Old",
      "notes": "",
      "tags": [],
      "createdAt": "2026-03-09T00:00:00Z",
      "updatedAt": "2026-03-10T10:00:00Z"
    }
  ],
  "metadata": {
    "createdAt": "2026-03-22T00:00:00Z",
    "version": "1.0"
  }
}
CALEOF

RESULT=$(bash "$EXECUTE" "{
  \"projectPath\": \"${TEST_PROJECT}\",
  \"weekEndDate\": \"2026-03-29\",
  \"businessName\": \"TestBiz\"
}")

assert_true "returns success" "$(echo "$RESULT" | jq -r '.success')"
assert_eq "totalPosts is 4" "4" "$(echo "$RESULT" | jq -r '.report.totalPosts')"
assert_eq "publishedCount is 2" "2" "$(echo "$RESULT" | jq -r '.report.publishedCount')"
assert_eq "completionRate is 50" "50" "$(echo "$RESULT" | jq -r '.report.completionRate')"

# Platform breakdown
assert_eq "x platform count" "2" "$(echo "$RESULT" | jq -r '.report.platformBreakdown.x')"
assert_eq "linkedin platform count" "2" "$(echo "$RESULT" | jq -r '.report.platformBreakdown.linkedin')"

# Status breakdown
assert_eq "published status count" "2" "$(echo "$RESULT" | jq -r '.report.statusBreakdown.published')"
assert_eq "draft status count" "1" "$(echo "$RESULT" | jq -r '.report.statusBreakdown.draft')"
assert_eq "ready status count" "1" "$(echo "$RESULT" | jq -r '.report.statusBreakdown.ready')"

# Pipeline health
assert_eq "pipeline draft count" "1" "$(echo "$RESULT" | jq -r '.report.pipelineHealth.draft')"
assert_eq "pipeline ready count" "1" "$(echo "$RESULT" | jq -r '.report.pipelineHealth.ready')"
assert_eq "pipeline published count" "2" "$(echo "$RESULT" | jq -r '.report.pipelineHealth.published')"

# Recommendations
assert_true "has recommendations" "$(echo "$RESULT" | jq -r '.report.recommendations | length > 0')"

# Markdown output
assert_true "markdown contains business name" "$(echo "$RESULT" | jq -r '.markdown' | grep -q 'TestBiz' && echo true || echo false)"
assert_true "markdown contains Platform Breakdown" "$(echo "$RESULT" | jq -r '.markdown' | grep -q 'Platform Breakdown' && echo true || echo false)"

# ─────────────────────────────────────────────
# Test 4: Excludes out-of-range entries
# ─────────────────────────────────────────────
echo "Test 4: Excludes out-of-range entries"
# The old post (2026-03-10) should NOT be in the week ending 2026-03-29
assert_eq "old post excluded from count" "4" "$(echo "$RESULT" | jq -r '.report.totalPosts')"

# ─────────────────────────────────────────────
# Test 5: Report with custom calendarPath
# ─────────────────────────────────────────────
echo "Test 5: Custom calendarPath"
CUSTOM_CAL=$(mktemp)
cat > "$CUSTOM_CAL" << 'CALEOF'
{
  "entries": [
    {
      "id": "cc-custom-001",
      "title": "Custom Post",
      "platform": "x",
      "type": "post",
      "scheduledDate": "2026-04-01",
      "status": "published",
      "publishedAt": "2026-04-01T10:00:00Z",
      "line": "crewly",
      "topic": "Custom",
      "notes": "",
      "tags": [],
      "createdAt": "2026-04-01T00:00:00Z",
      "updatedAt": "2026-04-01T10:00:00Z"
    }
  ],
  "metadata": {"createdAt":"2026-04-01T00:00:00Z","version":"1.0"}
}
CALEOF

RESULT=$(bash "$EXECUTE" "{
  \"calendarPath\": \"${CUSTOM_CAL}\",
  \"weekEndDate\": \"2026-04-05\",
  \"businessName\": \"CustomBiz\"
}")

assert_true "returns success with custom path" "$(echo "$RESULT" | jq -r '.success')"
assert_eq "finds 1 entry" "1" "$(echo "$RESULT" | jq -r '.report.totalPosts')"
rm -f "$CUSTOM_CAL"

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
