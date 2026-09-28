#!/bin/bash
# Tests for ORC render-verdict execute.sh (#819)
#
# The harness runs a COPY of the real execute.sh under a stubbed api_call
# (source real lib.sh + override api_call — the pattern used by
# delegate-task/execute.test.sh), so production logic is exercised verbatim.
#
# Coverage:
#   1. happy path — POSTs to the verdict endpoint with the right body
#   2. comment is included when given, omitted when not
#   3. an invalid verdict is rejected BEFORE any HTTP call (this is the
#      whole point of the skill: never let a malformed request reach the
#      backend and produce a confusing error)
#   4. workItemId is required
#   5. taskId is accepted as an alias for workItemId

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

CALL_LOG=$(mktemp)
SKILL_PARENT=$(mktemp -d)
trap 'rm -rf "$SKILL_PARENT" "$CALL_LOG"' EXIT

mkdir -p "$SKILL_PARENT/_common" "$SKILL_PARENT/render-verdict"

REAL_LIB="$(cd "$SCRIPT_DIR/../.." && pwd)/_common/lib.sh"
cat > "$SKILL_PARENT/_common/lib.sh" <<EOF
source "$REAL_LIB"
api_call() {
  local method="\$1" path="\$2" body="\${3:-}"
  echo "\${method} \${path} \${body}" >> "${CALL_LOG}"
  echo '{"success":true,"data":{"id":"wi-stub-id","status":"verified"}}'
}
EOF

cp "$SCRIPT_DIR/execute.sh" "$SKILL_PARENT/render-verdict/execute.sh"
chmod +x "$SKILL_PARENT/render-verdict/execute.sh"

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

assert_log_empty() {
  local desc="$1"
  if [ -s "$CALL_LOG" ]; then
    echo "  FAIL: $desc (expected NO api_call, got:)"
    sed 's/^/    /' "$CALL_LOG"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  fi
}

echo "=== ORC render-verdict ==="

# --- Test 1: happy path, no comment ---
> "$CALL_LOG"
OUT=$(bash "${SKILL_PARENT}/render-verdict/execute.sh" '{"workItemId":"wi-1","verdict":"verified"}' 2>&1 || true)
assert_log_contains "POSTs to the verdict endpoint" "POST /task-pool/items/wi-1/verdict"
assert_log_contains "body carries verdict=verified" '"verdict": "verified"'
if echo "$OUT" | grep -q '"comment"'; then
  echo "  FAIL: body should omit comment when none was given"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: no comment field sent when none was given"
  PASS=$((PASS + 1))
fi

# --- Test 2: comment is included when given (rejection path) ---
> "$CALL_LOG"
bash "${SKILL_PARENT}/render-verdict/execute.sh" \
  '{"workItemId":"wi-2","verdict":"rejected","comment":"Missing tests"}' >/dev/null 2>&1 || true
assert_log_contains "POSTs to the verdict endpoint" "POST /task-pool/items/wi-2/verdict"
assert_log_contains "body carries verdict=rejected" '"verdict": "rejected"'
assert_log_contains "body carries the comment" '"comment": "Missing tests"'

# --- Test 3: an invalid verdict never reaches api_call ---
> "$CALL_LOG"
OUT=$(bash "${SKILL_PARENT}/render-verdict/execute.sh" '{"workItemId":"wi-3","verdict":"approved"}' 2>&1 || true)
assert_log_empty "invalid verdict makes no HTTP call"
if echo "$OUT" | grep -qi "verdict must be"; then
  echo "  PASS: error names the accepted values"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected an error naming accepted verdict values, got: $OUT"
  FAIL=$((FAIL + 1))
fi

# --- Test 4: workItemId is required ---
> "$CALL_LOG"
OUT=$(bash "${SKILL_PARENT}/render-verdict/execute.sh" '{"verdict":"verified"}' 2>&1 || true)
assert_log_empty "missing workItemId makes no HTTP call"
if echo "$OUT" | grep -qi "workItemId"; then
  echo "  PASS: error names the missing param"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected an error naming workItemId, got: $OUT"
  FAIL=$((FAIL + 1))
fi

# --- Test 5: taskId is accepted as an alias for workItemId ---
> "$CALL_LOG"
bash "${SKILL_PARENT}/render-verdict/execute.sh" '{"taskId":"wi-4","verdict":"verified"}' >/dev/null 2>&1 || true
assert_log_contains "taskId alias resolves to the same endpoint" "POST /task-pool/items/wi-4/verdict"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
