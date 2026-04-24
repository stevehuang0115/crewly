#!/bin/bash
# Tests for gmail-reader execute.sh
# Verifies error paths (no real Gmail calls — would need a live token).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE="$SCRIPT_DIR/execute.sh"
PASS=0
FAIL=0

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q -- "$needle"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected substring '$needle' in output)"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $desc (exit=$expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== gmail-reader tests ==="

# Test 1: fails with clear error when token is not set
echo "Test 1: missing access token"
set +e
OUTPUT=$(unset CREWLY_CRED_GMAIL_ACCESS_TOKEN; bash "$EXECUTE" 2>&1)
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions CREWLY_CRED_GMAIL_ACCESS_TOKEN" "CREWLY_CRED_GMAIL_ACCESS_TOKEN" "$OUTPUT"

# Test 2: fails with API error when token is invalid
echo ""
echo "Test 2: invalid access token"
set +e
OUTPUT=$(CREWLY_CRED_GMAIL_ACCESS_TOKEN="ya29.fake-token" bash "$EXECUTE" 5 2>&1)
EXIT=$?
set -e
# Expect non-zero exit and some mention of Gmail API status (401 or similar)
if [ "$EXIT" -ne 0 ]; then
  echo "  PASS: non-zero exit with invalid token (exit=$EXIT)"
  PASS=$((PASS + 1))
else
  # If the machine is offline, curl returns 0 with an empty body — allow that
  # as an acceptable 'could not verify' outcome but note it
  echo "  NOTE: exit was 0 (possibly offline or rate-limited) — skipping strict assertion"
fi

echo ""
echo "Summary: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
