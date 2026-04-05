#!/bin/bash
# Tests for the Agent Workspace Skill (execute.sh)
#
# These tests verify argument parsing, JSON building, and error handling.
# Uses a mock API server (nc/ncat) or validates output without network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE="${SCRIPT_DIR}/execute.sh"

PASS=0
FAIL=0
TOTAL=0

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $label"
    echo "     expected: $expected"
    echo "     actual:   $actual"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -qE "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✅ $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $label"
    echo "     expected to contain: $needle"
    echo "     actual: $haystack"
  fi
}

assert_exit_code() {
  local label="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" >/dev/null 2>&1 || actual_code=$?
  TOTAL=$((TOTAL + 1))
  if [ "$actual_code" -eq "$expected_code" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $label (exit=$actual_code)"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $label"
    echo "     expected exit code: $expected_code"
    echo "     actual exit code:   $actual_code"
  fi
}

# ---------------------------------------------------------------------------
# Tests: Missing required params
# ---------------------------------------------------------------------------
echo "=== Missing required params ==="

assert_exit_code "No args → error" 1 bash "$EXECUTE"
assert_exit_code "Missing action → error" 1 bash "$EXECUTE" --id ws-1
assert_exit_code "read: missing id → error" 1 bash "$EXECUTE" --action read
assert_exit_code "write: missing id → error" 1 bash "$EXECUTE" --action write --version 1 --writer a --data '{}'
assert_exit_code "write: missing version → error" 1 bash "$EXECUTE" --action write --id ws-1 --writer a --data '{}'
assert_exit_code "write: missing writer → error" 1 bash "$EXECUTE" --action write --id ws-1 --version 1 --data '{}'
assert_exit_code "write: missing data → error" 1 bash "$EXECUTE" --action write --id ws-1 --version 1 --writer a
assert_exit_code "create: missing name → error" 1 bash "$EXECUTE" --action create --owner-type agent --owner-id a1
assert_exit_code "create: missing owner-type → error" 1 bash "$EXECUTE" --action create --name test --owner-id a1
assert_exit_code "create: missing owner-id → error" 1 bash "$EXECUTE" --action create --name test --owner-type agent

# ---------------------------------------------------------------------------
# Tests: Help flag
# ---------------------------------------------------------------------------
echo ""
echo "=== Help flag ==="

HELP_OUT=$(bash "$EXECUTE" --help 2>&1 || true)
assert_contains "help shows usage" "Usage:" "$HELP_OUT"
assert_contains "help shows actions" "read" "$HELP_OUT"
assert_contains "help shows write action" "write" "$HELP_OUT"
assert_contains "help shows create action" "create" "$HELP_OUT"
assert_contains "help shows list action" "list" "$HELP_OUT"

# ---------------------------------------------------------------------------
# Tests: Unknown action
# ---------------------------------------------------------------------------
echo ""
echo "=== Unknown action ==="

# Point to a port that won't respond — we just want the script to reach the error
export CREWLY_API_URL="http://127.0.0.1:19999"

ERR_OUT=$(bash "$EXECUTE" --action bogus 2>&1 || true)
assert_contains "unknown action → error message" "Unknown action" "$ERR_OUT"

# ---------------------------------------------------------------------------
# Tests: JSON input parsing
# ---------------------------------------------------------------------------
echo ""
echo "=== JSON input parsing ==="

# JSON input tests verify that parameter parsing reaches the API call stage
# (i.e., all required params were parsed successfully from JSON).
# The API call itself will fail since the mock server is unreachable — we just
# verify the script doesn't fail on param validation (exit 1 from require_param)
# but instead fails later at the API call (exit code != 1 from param error).

# read via JSON — should pass param validation, fail at API
EXIT_CODE=0
bash "$EXECUTE" '{"action":"read","id":"ws-test-123"}' >/dev/null 2>&1 || EXIT_CODE=$?
# Exit code 7 = curl connection refused (param parsing succeeded)
# Exit code 1 = param validation error (param parsing failed)
TOTAL=$((TOTAL + 1))
if [ "$EXIT_CODE" -ne 0 ] && [ "$EXIT_CODE" -ne 1 ]; then
  PASS=$((PASS + 1))
  echo "  ✅ JSON read parses id (exit=$EXIT_CODE, not param error)"
elif [ "$EXIT_CODE" -eq 1 ]; then
  FAIL=$((FAIL + 1))
  echo "  ❌ JSON read parses id — failed on param validation"
else
  PASS=$((PASS + 1))
  echo "  ✅ JSON read parses id (API reachable, exit=0)"
fi

# list via JSON
EXIT_CODE=0
bash "$EXECUTE" '{"action":"list"}' >/dev/null 2>&1 || EXIT_CODE=$?
TOTAL=$((TOTAL + 1))
if [ "$EXIT_CODE" -ne 1 ]; then
  PASS=$((PASS + 1))
  echo "  ✅ JSON list action works (exit=$EXIT_CODE)"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ JSON list action — failed on param validation"
fi

# create via JSON
EXIT_CODE=0
bash "$EXECUTE" '{"action":"create","name":"test ws","ownerType":"agent","ownerId":"agent-1"}' >/dev/null 2>&1 || EXIT_CODE=$?
TOTAL=$((TOTAL + 1))
if [ "$EXIT_CODE" -ne 1 ]; then
  PASS=$((PASS + 1))
  echo "  ✅ JSON create parses params (exit=$EXIT_CODE)"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ JSON create — failed on param validation"
fi

# write via JSON
EXIT_CODE=0
bash "$EXECUTE" '{"action":"write","id":"ws-1","data":{"k":"v"},"expectedVersion":1,"writerId":"agent-1"}' >/dev/null 2>&1 || EXIT_CODE=$?
TOTAL=$((TOTAL + 1))
if [ "$EXIT_CODE" -ne 1 ]; then
  PASS=$((PASS + 1))
  echo "  ✅ JSON write parses params (exit=$EXIT_CODE)"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ JSON write — failed on param validation"
fi

unset CREWLY_API_URL

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results ==="
echo "  Total: $TOTAL  Passed: $PASS  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ SOME TESTS FAILED"
  exit 1
else
  echo "  ✅ ALL TESTS PASSED"
  exit 0
fi
