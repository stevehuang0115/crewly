#!/bin/bash
# Tests for list-missions — run with: bash execute.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
check() { local name="$1"; local got="$2"; local want="$3"; if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/skills/orchestrator/list-missions" "$TMP/skills/orchestrator/_common"
cp "$HERE/execute.sh" "$TMP/skills/orchestrator/list-missions/execute.sh"
# The wrapper lib is the REAL lib.sh plus an api_call double, so the real
# api_call_full is what the skill exercises (a passthrough stub would let an
# envelope crash jq on both the fixed and the unfixed skill, guarding nothing).
# The double returns $MOCK_RESPONSE when set, else the canned missions.
REAL_LIB="$(cd "$HERE/../../_common" && pwd)/lib.sh"
MISSIONS='{"success":true,"data":[
 {"id":"m-company","level":"company","objective":"Q4 stable delivery","status":"active","approval":{"state":"approved"},"keyResults":[]},
 {"id":"m-team","level":"team","objective":"Portal team flow","status":"active","approval":{"state":"pending_approval"},"parentMissionId":"m-company",
  "keyResults":[{"id":"k1","title":"KR1 review backlog","current":3,"target":2,"unit":"tickets","status":"on_track","measurementSource":"skill_output","measurements":[]}]}
]}'
cat > "$TMP/skills/orchestrator/_common/lib.sh" <<'STUB'
source "$REAL_LIB"
api_call() { printf '%s' "${MOCK_RESPONSE:-$MISSIONS}"; }
STUB
export REAL_LIB MISSIONS

run() {  # run [skill args...] -> CODE, OUT (stdout), ERR (stderr)
  CODE=0
  OUT=$(env -u CREWLY_SESSION_NAME bash "$TMP/skills/orchestrator/list-missions/execute.sh" "$@" 2>"$TMP/err") || CODE=$?
  ERR=$(cat "$TMP/err")
}

run
check "count" "$(printf '%s' "$OUT" | jq '.count')" "2"
check "pending count" "$(printf '%s' "$OUT" | jq '.pendingApproval')" "1"
check "approval defaulted for legacy" "$(printf '%s' "$OUT" | jq -r '.missions[0].approval')" "approved"
check "KR compacted" "$(printf '%s' "$OUT" | jq -c '.missions[1].keyResults[0]')" '{"title":"KR1 review backlog","current":3,"target":2,"unit":"tickets","status":"on_track","measurementSource":"skill_output"}'
run --pending
check "--pending filters" "$(printf '%s' "$OUT" | jq -r '.missions | map(.id) | join(",")')" "m-team"
run --full
check "--full is raw" "$(printf '%s' "$OUT" | jq -r '.success')" "true"

# --- Truncated envelope: the skill must not turn it into "no missions" -------
# What api_call hands back when GET /missions is over the output cap. With the
# parked file unreadable there is no way to get the rows: exit 1, print
# nothing a caller could mistake for a list, and say why (explicit error field).
ENVELOPE='{"truncated":true,"bytes":70000,"file":"'"$TMP"'/nonexistent.json","head":"{\"success\":true,\"data\":[{","hint":"pass --full or read the file"}'
MOCK_RESPONSE="$ENVELOPE" run
check "envelope, unreadable file -> exit 1 (not a jq crash, not 0)" "$CODE" "1"
check "envelope, unreadable file -> no rows on stdout" "$OUT" ""
check "envelope, unreadable file -> explicit truncated error on stderr" "$(printf '%s' "$ERR" | grep -c '"truncated":true')" "1"

# With the parked file readable, the real rows are recovered from it.
printf '%s' "$MISSIONS" > "$TMP/parked.json"
MOCK_RESPONSE='{"truncated":true,"bytes":70000,"file":"'"$TMP"'/parked.json","head":"","hint":"x"}' run
check "envelope, readable file -> exit 0" "$CODE" "0"
check "envelope, readable file -> rows recovered from the parked file" "$(printf '%s' "$OUT" | jq -r '.count')" "2"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
