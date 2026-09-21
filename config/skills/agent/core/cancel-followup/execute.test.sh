#!/bin/bash
# Validation tests for cancel-followup skill.
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

echo "=== cancel-followup tests ==="

echo ""
echo "--- Required args ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" 2>&1) || true
assert_contains "Empty args rejected" "One of --id or --name" "$OUTPUT"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '{}' 2>&1) || true
assert_contains "Empty JSON rejected" "One of --id or --name" "$OUTPUT"

echo ""
echo "--- Help ---"

OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" --help 2>&1) || true
assert_contains "Help lists --id" -- "--id" "$OUTPUT"
assert_contains "Help lists --name" -- "--name" "$OUTPUT"

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
echo "--- Name lookup: a truncated list must not read as 'not found' ---"

# Real skill + real lib.sh, with api_call swapped for a double: GET /triggers
# returns $MOCK_RESPONSE, POST .../cancel is logged and acknowledged.
REAL_LIB="$(cd "$SCRIPT_DIR/../../../_common" && pwd)/lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/skills/agent/core/cancel-followup" "$TMP/skills/agent/_common"
cp "$SCRIPT_DIR/execute.sh" "$TMP/skills/agent/core/cancel-followup/execute.sh"
cat > "$TMP/skills/agent/_common/lib.sh" <<'STUB_EOF'
source "$REAL_LIB"
resolve_team_id() { echo "team-a"; }
api_call() {
  echo "$1 $2" >> "$API_LOG"
  case "$1 $2" in
    "GET /triggers") printf '%s' "$MOCK_RESPONSE" ;;
    POST\ /triggers/*/cancel) printf '{"success":true,"data":{"status":"cancelled"}}' ;;
    *) printf '{"success":true}' ;;
  esac
}
STUB_EOF

run() {
  local mock="$1"; shift
  CODE=0
  : > "$TMP/api.log"
  OUTPUT=$(env -u CREWLY_SESSION_NAME REAL_LIB="$REAL_LIB" API_LOG="$TMP/api.log" MOCK_RESPONSE="$mock" \
    bash "$TMP/skills/agent/core/cancel-followup/execute.sh" "$@" 2>/dev/null) || CODE=$?
}

ENVELOPE='{"truncated":true,"bytes":233481,"file":"'"$TMP"'/nonexistent.json","head":"{\"success\":true,\"data\":[{","hint":"pass --full or read the file"}'
ROWS='{"success":true,"data":[
  {"id":"t-1","teamId":"team-a","name":"followup:abc","status":"active"},
  {"id":"t-2","teamId":"team-b","name":"followup:zzz","status":"active"},
  {"id":"t-3","teamId":"team-a","name":"followup:old","status":"cancelled"}]}'

run "$ENVELOPE" --name followup:abc
assert_eq "Envelope -> non-zero exit" "1" "$CODE"
assert_contains "Envelope -> success:false" '"success":false' "$(printf '%s' "$OUTPUT" | jq -c .)"
assert_contains "Envelope -> explicit error, not 'not found'" 'truncated envelope' "$OUTPUT"
assert_eq "Envelope -> nothing cancelled" "" "$(grep POST "$TMP/api.log" || true)"

run "$ROWS" --name followup:abc
assert_eq "Match -> exit 0" "0" "$CODE"
assert_eq "Match -> cancels the team's trigger by id" "POST /triggers/t-1/cancel" "$(grep POST "$TMP/api.log")"
assert_eq "Match -> success:true" "true" "$(printf '%s' "$OUTPUT" | jq -r '.success')"

run "$ROWS" --name followup:zzz
assert_eq "Other team's name -> not found (team-scoped), exit 0" "0" "$CODE"
assert_contains "Other team's name -> not-found message" 'No active trigger found' "$OUTPUT"
assert_eq "Not found -> reports how many rows were examined" "3" "$(printf '%s' "$OUTPUT" | jq -r '.examined')"
assert_eq "Not found -> nothing cancelled" "" "$(grep POST "$TMP/api.log" || true)"

run "$ROWS" --name followup:old
assert_contains "Cancelled trigger -> not found (only active are cancellable)" 'No active trigger found' "$OUTPUT"

run '{"success":true,"data":"nope"}' --name followup:abc
assert_eq "Non-array .data -> non-zero exit" "1" "$CODE"
assert_contains "Non-array .data -> error says why" 'not-an-array' "$OUTPUT"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ]
