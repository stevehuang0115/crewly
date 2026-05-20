#!/bin/bash
# Tests for ORC delegate-task execute.sh
#
# Focused on the auto-claim transition added 2026-05-20 — the skill must
# call POST /task-pool/claim immediately after POST /task-pool/add succeeds,
# so the WI transitions queued → running at dispatch time and doesn't rot
# in queued waiting for a pull that may never come (the 2026-05-20
# ESTestNode incident).
#
# The skill is exercised under a stubbed api_call that records every
# REST call to a tmp file; assertions look at the call log + final JSON.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

CALL_LOG=$(mktemp)
SKILL_PARENT=$(mktemp -d)
trap 'rm -rf "$SKILL_PARENT" "$CALL_LOG"' EXIT

# Build a fake skill-parent dir that mirrors config/skills layout:
#   <SKILL_PARENT>/_common/lib.sh   ← real lib.sh + api_call override
#   <SKILL_PARENT>/delegate-task/execute.sh   ← real skill copy
# The skill resolves `${SCRIPT_DIR}/../_common/lib.sh`, so this layout
# satisfies the source path.
mkdir -p "$SKILL_PARENT/_common" "$SKILL_PARENT/delegate-task"

# Compose a test lib.sh: source the real one (for require_param,
# resolve_team_id, auto_remember, etc.) then override api_call so we
# can record + canned-reply without making real HTTP calls.
REAL_LIB="$(cd "$SCRIPT_DIR/../.." && pwd)/_common/lib.sh"
cat > "$SKILL_PARENT/_common/lib.sh" <<EOF
source "$REAL_LIB"
api_call() {
  local method="\$1" path="\$2" body="\${3:-}"
  echo "\${method} \${path} \${body}" >> "${CALL_LOG}"
  case "\${path}" in
    /task-pool/add)
      echo '{"success":true,"data":{"id":"wi-stub-id"}}'
      ;;
    /task-pool/claim)
      if [ "\${TEST_CLAIM_FAIL:-0}" = "1" ]; then
        echo '{"success":false,"error":"claim race"}'
      else
        echo '{"success":true,"data":{"claimId":"c-stub"}}'
      fi
      ;;
    /triggers)
      if [ "\${TEST_TRIGGER_FAIL:-0}" = "1" ]; then
        echo '{"success":false,"error":"trigger backend down"}'
      else
        echo '{"success":true,"data":{"id":"trg-stub-id"}}'
      fi
      ;;
    *)
      echo '{"success":true}'
      ;;
  esac
}
EOF

cp "$SCRIPT_DIR/execute.sh" "$SKILL_PARENT/delegate-task/execute.sh"
chmod +x "$SKILL_PARENT/delegate-task/execute.sh"

assert_log_contains() {
  local desc="$1" pattern="$2"
  if grep -q "$pattern" "$CALL_LOG"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected log entry matching '$pattern')"
    echo "  Call log was:"
    sed 's/^/    /' "$CALL_LOG"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_contains() {
  local desc="$1" expected="$2" output="$3"
  if echo "$output" | grep -q "$expected"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$expected' in output, got: $output)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== ORC delegate-task — auto-claim regression ==="

# --- Test 1: happy path — claim is called after add ---
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "Test delegation" \
  --priority normal \
  2>&1 || true)

assert_log_contains "POST /task-pool/add fires first" "POST /task-pool/add"
assert_log_contains "POST /task-pool/claim fires after add" "POST /task-pool/claim"
assert_output_contains "result state=running on successful claim" '"state": "running"' "$OUT"
assert_output_contains "result reports immediate claim" "immediately claimed" "$OUT"

# Verify ORDER — claim must come AFTER add
ADD_LINE=$(grep -n "POST /task-pool/add" "$CALL_LOG" | head -1 | cut -d: -f1)
CLAIM_LINE=$(grep -n "POST /task-pool/claim" "$CALL_LOG" | head -1 | cut -d: -f1)
if [ -n "$ADD_LINE" ] && [ -n "$CLAIM_LINE" ] && [ "$ADD_LINE" -lt "$CLAIM_LINE" ]; then
  echo "  PASS: claim fires AFTER add (lines $ADD_LINE < $CLAIM_LINE)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: claim should fire AFTER add (add=$ADD_LINE claim=$CLAIM_LINE)"
  FAIL=$((FAIL + 1))
fi

# Verify claim body carries the target session as agentId
assert_log_contains "claim body names target as agentId" 'crewly-test-bob'

# --- Test 2: claim failure is non-fatal ---
> "$CALL_LOG"
OUT=$(TEST_CLAIM_FAIL=1 CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "Test delegation" \
  --priority normal \
  2>/dev/null || true)

assert_log_contains "POST /task-pool/add still fires when claim will fail" "POST /task-pool/add"
assert_log_contains "POST /task-pool/claim is attempted" "POST /task-pool/claim"
assert_output_contains "result state=queued on claim failure" '"state": "queued"' "$OUT"
assert_output_contains "result still reports success when claim fails" '"success": true' "$OUT"

# --- Test 3: fallback trigger fires by default ---
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "Test delegation with fallback" \
  --priority normal \
  2>/dev/null || true)

assert_log_contains "POST /triggers fires after dispatch by default" "POST /triggers"
assert_output_contains "result reports fallbackTriggerId" "fallbackTriggerId" "$OUT"
assert_output_contains "result reports fallbackMinutes=30 (default)" '"fallbackMinutes": 30' "$OUT"

# --- Test 4: fallback can be disabled via --fallback-minutes 0 ---
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "Quick fire-and-forget" \
  --fallback-minutes 0 \
  2>/dev/null || true)

if grep -q "POST /triggers" "$CALL_LOG"; then
  echo "  FAIL: --fallback-minutes 0 should suppress trigger creation"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: --fallback-minutes 0 suppresses trigger creation"
  PASS=$((PASS + 1))
fi
if echo "$OUT" | grep -q "fallbackTriggerId"; then
  echo "  FAIL: output should not include fallbackTriggerId when disabled"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: output omits fallbackTriggerId when disabled"
  PASS=$((PASS + 1))
fi

# --- Test 5: trigger failure is non-fatal (dispatch still succeeds) ---
> "$CALL_LOG"
OUT=$(TEST_TRIGGER_FAIL=1 CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "Trigger backend will fail" \
  2>/dev/null || true)

assert_output_contains "result still success when trigger fails" '"success": true' "$OUT"
if echo "$OUT" | grep -q "fallbackTriggerId"; then
  echo "  FAIL: output should not include fallbackTriggerId when trigger create fails"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: output omits fallbackTriggerId when trigger creation fails"
  PASS=$((PASS + 1))
fi

# --- Test 6: custom --fallback-minutes is propagated ---
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "Long-running milestone" \
  --fallback-minutes 120 \
  2>/dev/null || true)

assert_output_contains "result reports custom fallbackMinutes=120" '"fallbackMinutes": 120' "$OUT"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
