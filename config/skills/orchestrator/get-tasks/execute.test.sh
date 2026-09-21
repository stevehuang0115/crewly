#!/bin/bash
# Tests for get-tasks — run with: bash execute.test.sh
#
# The pool is fetched whole (3.5 MB / 760 rows on a busy install) and reduced
# here, so the skill must (a) report how many rows it examined, (b) print only
# non-terminal items in compact form, and (c) fail loudly — never print
# workItems: [] — when the list is unknown.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
check() { local name="$1"; local got="$2"; local want="$3"; if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/skills/orchestrator/get-tasks" "$TMP/skills/orchestrator/_common"
cp "$HERE/execute.sh" "$TMP/skills/orchestrator/get-tasks/execute.sh"
# Real lib.sh plus an api_call double, so the real api_call_full is exercised.
REAL_LIB="$(cd "$HERE/../../_common" && pwd)/lib.sh"
cat > "$TMP/skills/orchestrator/_common/lib.sh" <<'STUB'
source "$REAL_LIB"
api_call() {
  case "$2" in
    /task-pool/stats) printf '{"success":true,"data":{"total":4,"byStatus":{"verified":2,"running":1,"queued":1}}}' ;;
    /task-pool/items) printf '%s' "$MOCK_ITEMS" ;;
  esac
}
STUB

run() {
  CODE=0
  OUT=$(env -u CREWLY_SESSION_NAME REAL_LIB="$REAL_LIB" MOCK_ITEMS="$1" bash "$TMP/skills/orchestrator/get-tasks/execute.sh" 2>/dev/null) || CODE=$?
}

ITEMS='{"success":true,"data":[
 {"id":"w-1","type":"delegate","status":"verified","owner":"team_lead","target":"a","title":"old","briefMarkdown":"huge","createdAt":"t1"},
 {"id":"w-2","type":"delegate","status":"running","owner":"team_lead","target":"b","title":"'"$(printf 'x%.0s' $(seq 1 200))"'","briefMarkdown":"huge","createdAt":"t2","startedAt":"t3"},
 {"id":"w-3","type":"review","status":"queued","owner":"orchestrator","target":"c","title":"pending review","createdAt":"t4"},
 {"id":"w-4","type":"delegate","status":"cancelled","owner":"team_lead","target":"d","title":"gone","createdAt":"t5"}]}'

run "$ITEMS"
check "exit 0" "$CODE" "0"
check "success" "$(printf '%s' "$OUT" | jq -r '.success')" "true"
check "examined = every row before filtering" "$(printf '%s' "$OUT" | jq -r '.examined')" "4"
check "only non-terminal items are listed" "$(printf '%s' "$OUT" | jq -r '.workItems | map(.id) | join(",")')" "w-2,w-3"
check "items are compacted (no briefMarkdown)" "$(printf '%s' "$OUT" | jq -r '.workItems[0] | has("briefMarkdown")')" "false"
check "title clipped to 120 chars" "$(printf '%s' "$OUT" | jq -r '.workItems[0].title | length')" "120"
check "stats passed through" "$(printf '%s' "$OUT" | jq -r '.stats.byStatus.running')" "1"
check "no error field on success" "$(printf '%s' "$OUT" | jq -r 'has("error")')" "false"

# A truncated envelope (parked file missing) must be an error, not an empty pool.
run '{"truncated":true,"bytes":3487577,"file":"'"$TMP"'/nope.json","head":"","hint":"x"}'
check "envelope -> exit 1" "$CODE" "1"
check "envelope -> success:false" "$(printf '%s' "$OUT" | jq -r '.success')" "false"
check "envelope -> examined 0, not a fake count" "$(printf '%s' "$OUT" | jq -r '.examined')" "0"
check "envelope -> error says UNKNOWN" "$(printf '%s' "$OUT" | jq -r '.error' | grep -c UNKNOWN)" "1"

# A body whose .data is not an array is likewise unknown.
run '{"success":true,"data":{"oops":1}}'
check "non-array -> exit 1" "$CODE" "1"
check "non-array -> success:false with error" "$(printf '%s' "$OUT" | jq -r '.success, (.error|type)' | paste -sd, -)" "false,string"

# An empty pool is a legitimate zero: success, examined 0, exit 0.
run '{"success":true,"data":[]}'
check "empty pool -> exit 0" "$CODE" "0"
check "empty pool -> success with examined 0" "$(printf '%s' "$OUT" | jq -r '"\(.success)/\(.examined)/\(.workItems|length)"')" "true/0/0"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
