#!/bin/bash
# Tests for ORC delegate-task execute.sh
#
# Covers two things:
#   1. the auto-claim transition (Tests 1-6), and
#   2. the Request Contract checker (Test 7), which scans BOTH `--task` and
#      `--context` — see the note above Test 7.
#
# Note the harness runs a COPY of the real execute.sh under a stubbed
# api_call, so production logic is exercised verbatim; no part of the skill
# is reimplemented here. Keep it that way — a hand-copied mirror of skill
# logic silently stops tracking the skill.
#
# Tests 1-6 are focused on the auto-claim transition added 2026-05-20 — the skill must
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

# ---------------------------------------------------------------------------
# Test 7: Request Contract checker scans --task AND --context
#
# The checker used to read only `--task`. This skill has its own `--context`
# flag and delivers it to the target, so an orchestrator that put the
# long-form Goal / Expected Outcome / Eval Criteria in `--context` was told
# the contract was "incomplete" while every marker was in fact present. That
# false positive is what the Brief Reception Protocol keys off, so it has to
# be right in both directions: silent when the contract is present anywhere,
# and still loud when a marker is in neither field.
# ---------------------------------------------------------------------------
echo ""
echo "=== ORC delegate-task — Request Contract checker ==="

CTX_FULL="**Goal:** Ship the importer. **Expected Outcome:** CSVs land in prod. **Eval Criteria:** all tests green."

# 7a: contract entirely in --context — must NOT warn
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "build the importer" \
  --context "$CTX_FULL" \
  2>&1 || true)
if echo "$OUT" | grep -q "Request Contract incomplete"; then
  echo "  FAIL: contract present in --context was still reported incomplete: $OUT"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: contract in --context suppresses the warning"
  PASS=$((PASS + 1))
fi

# 7b: contract split across --task and --context — must NOT warn
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "**Goal:** ship the importer" \
  --context "**Expected Outcome:** CSVs land in prod. **Eval Criteria:** all tests green." \
  2>&1 || true)
if echo "$OUT" | grep -q "Request Contract incomplete"; then
  echo "  FAIL: split contract was reported incomplete: $OUT"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: contract split across --task and --context suppresses the warning"
  PASS=$((PASS + 1))
fi

# 7c: contract entirely in --task, no --context — must NOT warn (no regression)
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "$CTX_FULL" \
  2>&1 || true)
if echo "$OUT" | grep -q "Request Contract incomplete"; then
  echo "  FAIL: contract in --task alone was reported incomplete: $OUT"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: contract in --task alone still suppresses the warning"
  PASS=$((PASS + 1))
fi

# 7d: one marker absent from BOTH — check is not weakened
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "**Goal:** ship it" \
  --context "**Expected Outcome:** it ships." \
  2>&1 || true)
if echo "$OUT" | grep -q "Request Contract incomplete" && echo "$OUT" | grep -q "Eval"; then
  echo "  PASS: still warns for the one marker absent from both fields"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected an Eval-missing warning, got: $OUT"
  FAIL=$((FAIL + 1))
fi

# 7e: nothing anywhere — all three still named
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "just do the thing" \
  --context "here is some background prose" \
  2>&1 || true)
if echo "$OUT" | grep -q "Request Contract incomplete" && \
   echo "$OUT" | grep -q "Goal" && \
   echo "$OUT" | grep -q "Outcome" && \
   echo "$OUT" | grep -q "Eval"; then
  echo "  PASS: all three markers reported missing"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected all three named, got: $OUT"
  FAIL=$((FAIL + 1))
fi

# 7f: warning stays non-fatal — dispatch still happens
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "unstructured task" \
  2>&1 || true)
assert_log_contains "dispatch proceeds despite an incomplete contract" "POST /task-pool/add"

# 7g: markers are not fabricated across the task/context seam
> "$CALL_LOG"
OUT=$(CALL_LOG="$CALL_LOG" CREWLY_ROOT=/tmp/crewly-test \
  bash "${SKILL_PARENT}/delegate-task/execute.sh" \
  --to crewly-test-bob \
  --task "please go" \
  --context "al: nothing here. Expected Outcome: y. Eval Criteria: z." \
  2>&1 || true)
if echo "$OUT" | grep -q "Request Contract incomplete" && echo "$OUT" | grep -q "Goal"; then
  echo "  PASS: seam does not fabricate a Goal marker"
  PASS=$((PASS + 1))
else
  echo "  FAIL: 'go'+'al:' across the seam was accepted as a Goal marker: $OUT"
  FAIL=$((FAIL + 1))
fi

# 7h: source-level guard on the production call site. The scenarios above run
# a copy of execute.sh, but pin the call line explicitly so reverting it to
# the task-only form fails loudly even if a future refactor moves the checker.
SRC=$(cat "$SCRIPT_DIR/execute.sh")
if printf '%s' "$SRC" | grep -q -- 'warn_missing_request_contract "$TASK" "$CONTEXT"'; then
  echo "  PASS: call site passes \$TASK and \$CONTEXT"
  PASS=$((PASS + 1))
else
  echo "  FAIL: execute.sh does not call warn_missing_request_contract with both fields"
  FAIL=$((FAIL + 1))
fi
if printf '%s' "$SRC" | grep -qE '^warn_missing_request_contract "\$TASK"$'; then
  echo "  FAIL: execute.sh still has a task-only call to the contract checker"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: no task-only call to the contract checker remains"
  PASS=$((PASS + 1))
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
