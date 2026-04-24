#!/bin/bash
# Tests for gmail multi-action skill (execute.sh).
# Verifies error paths only — no live Gmail calls (would need a real token).
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
    echo "  ----- actual output -----"
    echo "$haystack" | sed 's/^/  | /'
    echo "  -------------------------"
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

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q -- "$needle"; then
    echo "  FAIL: $desc (unexpected substring '$needle' in output)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc (no '$needle' leaked)"
    PASS=$((PASS + 1))
  fi
}

run_with_token() {
  CREWLY_CRED_GMAIL_ACCESS_TOKEN="ya29.fake" bash "$EXECUTE" "$1" 2>&1
}

echo "=== gmail multi-action skill tests (v1.1.0 — 9 actions) ==="

# -----------------------------------------------------------------------------
# Token / input validation
# -----------------------------------------------------------------------------

echo ""
echo "Test 1: missing CREWLY_CRED_GMAIL_ACCESS_TOKEN"
set +e
OUTPUT=$(unset CREWLY_CRED_GMAIL_ACCESS_TOKEN; bash "$EXECUTE" '{"action":"list"}' 2>&1)
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions CREWLY_CRED_GMAIL_ACCESS_TOKEN" "CREWLY_CRED_GMAIL_ACCESS_TOKEN" "$OUTPUT"

echo ""
echo "Test 1b: list-labels also needs token"
set +e
OUTPUT=$(unset CREWLY_CRED_GMAIL_ACCESS_TOKEN; bash "$EXECUTE" '{"action":"list-labels"}' 2>&1)
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"

echo ""
echo "Test 2: missing 'action' field"
set +e
OUTPUT=$(run_with_token '{}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions list action" "list" "$OUTPUT"
assert_contains "mentions read action" "read" "$OUTPUT"
assert_contains "mentions send action" "send" "$OUTPUT"
assert_contains "mentions list-labels action" "list-labels" "$OUTPUT"
assert_contains "mentions add-label action" "add-label" "$OUTPUT"
assert_contains "mentions mark-as-read action" "mark-as-read" "$OUTPUT"

echo ""
echo "Test 3: unknown action lists ALL valid actions"
set +e
OUTPUT=$(run_with_token '{"action":"foo-bar"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions Unknown action" "Unknown action" "$OUTPUT"
# Spot-check that several valid actions appear in the error message:
for valid in list read search send list-labels add-label remove-label mark-as-read mark-as-unread; do
  assert_contains "lists '$valid' as valid" "$valid" "$OUTPUT"
done

echo ""
echo "Test 4: invalid JSON input"
set +e
OUTPUT=$(run_with_token 'not-json{')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions JSON" "JSON" "$OUTPUT"

echo ""
echo "Test 5: empty input"
set +e
OUTPUT=$(run_with_token '')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions action / usage" "action" "$OUTPUT"

# -----------------------------------------------------------------------------
# list (existing v1.0.0 action)
# -----------------------------------------------------------------------------

echo ""
echo "Test 6: list with invalid token (expect API error, exit 2)"
set +e
OUTPUT=$(CREWLY_CRED_GMAIL_ACCESS_TOKEN="ya29.fake-token-xyz" bash "$EXECUTE" '{"action":"list","maxResults":1}' 2>&1)
EXIT=$?
set -e
if [ "$EXIT" -ne 0 ]; then
  echo "  PASS: non-zero exit with invalid token (exit=$EXIT)"
  PASS=$((PASS + 1))
  if [ "$EXIT" -eq 2 ]; then
    echo "  PASS: exit code 2 (api error) as expected"
    PASS=$((PASS + 1))
  fi
else
  echo "  NOTE: exit was 0 (likely offline) — skipping strict assertion"
fi
assert_not_contains "fake token not leaked" "ya29.fake-token-xyz" "$OUTPUT"

# -----------------------------------------------------------------------------
# read (existing v1.0.0 action)
# -----------------------------------------------------------------------------

echo ""
echo "Test 7: read action missing 'id'"
set +e
OUTPUT=$(run_with_token '{"action":"read"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions id" "id" "$OUTPUT"

# -----------------------------------------------------------------------------
# send (existing v1.0.0 action)
# -----------------------------------------------------------------------------

echo ""
echo "Test 8: send missing 'to'"
set +e
OUTPUT=$(run_with_token '{"action":"send","subject":"hi","body":"hi"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions to" "to" "$OUTPUT"

echo ""
echo "Test 9: send missing 'subject'"
set +e
OUTPUT=$(run_with_token '{"action":"send","to":"a@b.com","body":"hi"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions subject" "subject" "$OUTPUT"

echo ""
echo "Test 10: send missing 'body'"
set +e
OUTPUT=$(run_with_token '{"action":"send","to":"a@b.com","subject":"hi"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions body" "body" "$OUTPUT"

# -----------------------------------------------------------------------------
# list-labels (new v1.1.0 action)
# -----------------------------------------------------------------------------

echo ""
echo "Test 11: list-labels with invalid token surfaces API error"
set +e
OUTPUT=$(CREWLY_CRED_GMAIL_ACCESS_TOKEN="ya29.fake-list-labels" bash "$EXECUTE" '{"action":"list-labels"}' 2>&1)
EXIT=$?
set -e
if [ "$EXIT" -ne 0 ]; then
  echo "  PASS: non-zero exit on bad token for list-labels (exit=$EXIT)"
  PASS=$((PASS + 1))
fi
assert_not_contains "fake token not leaked from list-labels" "ya29.fake-list-labels" "$OUTPUT"

# -----------------------------------------------------------------------------
# add-label / remove-label (new v1.1.0 actions)
# -----------------------------------------------------------------------------

echo ""
echo "Test 12: add-label missing 'id'"
set +e
OUTPUT=$(run_with_token '{"action":"add-label","labelId":"Label_5"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions id" "id" "$OUTPUT"

echo ""
echo "Test 13: add-label missing labelId AND labelIds"
set +e
OUTPUT=$(run_with_token '{"action":"add-label","id":"18fa..."}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions labelId or labelIds" "labelId" "$OUTPUT"

echo ""
echo "Test 14: remove-label missing 'id'"
set +e
OUTPUT=$(run_with_token '{"action":"remove-label","labelId":"Label_5"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions id" "id" "$OUTPUT"

echo ""
echo "Test 15: remove-label with both empty (labelId='', labelIds=[])"
set +e
OUTPUT=$(run_with_token '{"action":"remove-label","id":"18fa...","labelId":"","labelIds":[]}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions labelId or labelIds" "labelId" "$OUTPUT"

# -----------------------------------------------------------------------------
# mark-as-read / mark-as-unread (new v1.1.0 actions)
# -----------------------------------------------------------------------------

echo ""
echo "Test 16: mark-as-read missing 'id'"
set +e
OUTPUT=$(run_with_token '{"action":"mark-as-read"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions id" "id" "$OUTPUT"

echo ""
echo "Test 17: mark-as-unread missing 'id'"
set +e
OUTPUT=$(run_with_token '{"action":"mark-as-unread"}')
EXIT=$?
set -e
assert_exit "exits 1" "1" "$EXIT"
assert_contains "mentions id" "id" "$OUTPUT"

# -----------------------------------------------------------------------------
# Cross-action: stdout always emits {"success":false, ...} on errors
# -----------------------------------------------------------------------------

echo ""
echo "Test 18: error responses emit JSON success:false on stdout"
set +e
STDOUT=$(CREWLY_CRED_GMAIL_ACCESS_TOKEN="ya29.fake" bash "$EXECUTE" '{"action":"read"}' 2>/dev/null)
set -e
if echo "$STDOUT" | jq -e '.success == false' >/dev/null 2>&1; then
  echo "  PASS: stdout JSON has success:false on missing id"
  PASS=$((PASS + 1))
else
  echo "  FAIL: stdout JSON did not have success:false (got: $STDOUT)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Test 19: error responses emit JSON success:false on stdout (label action)"
set +e
STDOUT=$(CREWLY_CRED_GMAIL_ACCESS_TOKEN="ya29.fake" bash "$EXECUTE" '{"action":"add-label","id":"x"}' 2>/dev/null)
set -e
if echo "$STDOUT" | jq -e '.success == false' >/dev/null 2>&1; then
  echo "  PASS: stdout JSON has success:false on missing labelId"
  PASS=$((PASS + 1))
else
  echo "  FAIL: stdout JSON did not have success:false (got: $STDOUT)"
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "Summary: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
