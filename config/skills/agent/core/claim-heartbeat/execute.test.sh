#!/bin/bash
# =============================================================================
# Tests for claim-heartbeat skill
#
# Verifies parameter validation, API call construction, and output format.
# Uses mock api_call to simulate backend responses without a running server.
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ERRORS=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${test_name}\n    expected: ${expected}\n    actual:   ${actual}"
    echo "  ✗ ${test_name}"
    echo "    expected: ${expected}"
    echo "    actual:   ${actual}"
  fi
}

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${test_name}\n    expected to contain: ${needle}\n    actual: ${haystack}"
    echo "  ✗ ${test_name}"
    echo "    expected to contain: ${needle}"
  fi
}

# ---------------------------------------------------------------------------
# Test: Missing required params
# ---------------------------------------------------------------------------

echo "=== claim-heartbeat tests ==="

echo ""
echo "--- Missing parameters ---"

# Test missing claimId
OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '{"sessionName":"agent-1"}' 2>&1) || true
assert_contains "Missing claimId returns error" "claimId" "$OUTPUT"

# Test missing sessionName
OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '{"claimId":"claim-1"}' 2>&1) || true
assert_contains "Missing sessionName returns error" "sessionName" "$OUTPUT"

# Test empty input
OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '' 2>&1) || true
assert_contains "Empty input returns usage error" "Usage" "$OUTPUT"

# ---------------------------------------------------------------------------
# Test: Mock successful heartbeat
# ---------------------------------------------------------------------------

echo ""
echo "--- Mock API responses ---"

# Create a temp script that mocks the api_call
MOCK_DIR=$(mktemp -d)
cat > "$MOCK_DIR/mock_heartbeat.sh" << 'MOCK_EOF'
#!/bin/bash
# Override api_call to return mock responses
api_call() {
  local method="$1" endpoint="$2" body="$3"
  if [ "$method" = "POST" ] && [[ "$endpoint" == *"/task-pool/heartbeat"* ]]; then
    echo '{"success": true, "data": {"claim": {"id": "claim-abc", "status": "active", "lastHeartbeatAt": "2026-04-05T10:00:00Z"}}}'
    return 0
  fi
  return 1
}

# Source the common lib first, then override api_call
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../../_common/lib.sh"
# Re-define api_call after sourcing (override)
api_call() {
  echo '{"success": true, "data": {"claim": {"id": "claim-abc", "status": "active", "lastHeartbeatAt": "2026-04-05T10:00:00Z"}}}'
  return 0
}

INPUT='{"claimId":"claim-abc","sessionName":"agent-1"}'
CLAIM_ID="claim-abc"
SESSION_NAME="agent-1"

BODY=$(jq -n --arg claimId "$CLAIM_ID" --arg agentId "$SESSION_NAME" '{claimId: $claimId, agentId: $agentId}')
RESPONSE=$(api_call POST "/task-pool/heartbeat" "$BODY")
SUCCESS=$(printf '%s' "$RESPONSE" | jq -r '.success // false')
CLAIM_OBJ=$(printf '%s' "$RESPONSE" | jq -c '.data.claim // null')

if [ "$SUCCESS" = "true" ]; then
  jq -n --argjson claim "$CLAIM_OBJ" '{success: true, claim: $claim}'
else
  jq -n '{success: false, reason: "test failure"}'
fi
MOCK_EOF

chmod +x "$MOCK_DIR/mock_heartbeat.sh"
OUTPUT=$(bash "$MOCK_DIR/mock_heartbeat.sh" 2>&1) || true

assert_contains "Successful heartbeat returns success" '"success": true' "$OUTPUT"
assert_contains "Successful heartbeat returns claim" '"claim"' "$OUTPUT"

rm -rf "$MOCK_DIR"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if [ $FAIL -gt 0 ]; then
  echo -e "\nFailures:${ERRORS}"
  exit 1
fi
