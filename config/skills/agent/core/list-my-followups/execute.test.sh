#!/bin/bash
# Validation tests for list-my-followups skill.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

echo "=== list-my-followups tests ==="

echo ""
echo "--- Help ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --help 2>&1) || true
assert_contains "Help mentions --status" -- "--status" "$OUTPUT"
assert_contains "Help mentions --name-prefix" -- "--name-prefix" "$OUTPUT"

echo ""
echo "--- Team resolution ---"

# Without CREWLY_SESSION_NAME, the skill must refuse rather than returning an
# all-teams dump. Clear env and run.
OUTPUT=$(env -u CREWLY_SESSION_NAME bash "$SCRIPT_DIR/execute.sh" 2>&1) || true
assert_contains "No session → team-resolve error" "Cannot resolve owning team" "$OUTPUT"

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ ${test_name}"
    echo "    expected: ${expected}"
    echo "    got:      ${actual}"
  fi
}

echo ""
echo "--- Response shape: a guard must report what it examined ---"

# Run the real skill against a lib.sh double: the REAL library plus an
# api_call override, so the real api_call_full is what the skill exercises.
# The double returns whatever $MOCK_RESPONSE holds, for any request.
REAL_LIB="$(cd "$SCRIPT_DIR/../../../_common" && pwd)/lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/skills/agent/core/list-my-followups" "$TMP/skills/agent/_common"
cp "$SCRIPT_DIR/execute.sh" "$TMP/skills/agent/core/list-my-followups/execute.sh"
cat > "$TMP/skills/agent/_common/lib.sh" <<'STUB_EOF'
source "$REAL_LIB"
resolve_team_id() { echo "team-a"; }
api_call() { printf '%s' "$MOCK_RESPONSE"; }
STUB_EOF

# run <mock-response> [skill args...] -> sets CODE and OUTPUT (stdout only)
run() {
  local mock="$1"; shift
  CODE=0
  OUTPUT=$(env -u CREWLY_SESSION_NAME REAL_LIB="$REAL_LIB" MOCK_RESPONSE="$mock" \
    bash "$TMP/skills/agent/core/list-my-followups/execute.sh" "$@" 2>/dev/null) || CODE=$?
}

# What api_call hands back when GET /triggers is over the output cap (233 KB /
# 335 rows on 2026-09-21). The parked file deliberately does not exist.
ENVELOPE='{"truncated":true,"bytes":233481,"file":"'"$TMP"'/nonexistent.json","head":"{\"success\":true,\"data\":[{\"id\":\"4bc7","hint":"pass --full or read the file"}'
ROWS='{"success":true,"data":[
  {"id":"t-1","teamId":"team-a","name":"followup:abc","status":"paused"},
  {"id":"t-2","teamId":"team-b","name":"followup:abc","status":"active"},
  {"id":"t-3","teamId":"team-b","name":"watch:x","status":"active"}]}'

run "$ENVELOPE"
assert_eq "Envelope -> non-zero exit" "1" "$CODE"
assert_contains "Envelope -> success:false" '"success":false' "$(printf '%s' "$OUTPUT" | jq -c .)"
assert_contains "Envelope -> explicit error field" 'truncated envelope' "$OUTPUT"
assert_eq "Envelope -> never count 0" "" "$(printf '%s' "$OUTPUT" | jq -r '.count // empty')"

run "$ROWS"
assert_eq "Rows -> exit 0" "0" "$CODE"
assert_eq "Rows -> examined counts every row before the team filter" "3" "$(printf '%s' "$OUTPUT" | jq -r '.examined')"
assert_eq "Rows -> count is the team's rows" "1" "$(printf '%s' "$OUTPUT" | jq -r '.count')"
assert_eq "Rows -> the team's trigger is returned" "t-1" "$(printf '%s' "$OUTPUT" | jq -r '.data[0].id')"

run "$ROWS" --status active
assert_eq "--status active with none active -> legitimate count 0" "0" "$(printf '%s' "$OUTPUT" | jq -r '.count')"
assert_eq "--status active -> examined still 3" "3" "$(printf '%s' "$OUTPUT" | jq -r '.examined')"
assert_eq "--status active -> success:true (this zero is real)" "true" "$(printf '%s' "$OUTPUT" | jq -r '.success')"

run "$ROWS" --name-prefix watch:
assert_eq "--name-prefix scoped to team -> count 0, examined 3" "0/3" "$(printf '%s' "$OUTPUT" | jq -r '"\(.count)/\(.examined)"')"

run '{"success":true,"data":{"oops":1}}'
assert_eq "Non-array .data -> non-zero exit" "1" "$CODE"
assert_contains "Non-array .data -> error says why" 'not-an-array' "$OUTPUT"

run '{"error":true,"status":500}'
assert_eq "Error object without .data -> non-zero exit" "1" "$CODE"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
