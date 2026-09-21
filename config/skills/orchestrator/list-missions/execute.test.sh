#!/bin/bash
# Tests for list-missions — run with: bash execute.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
check() { local name="$1"; local got="$2"; local want="$3"; if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# Stand-in for api_call: a shell function defined in a wrapper lib.
mkdir -p "$TMP/skills/orchestrator/list-missions" "$TMP/skills/orchestrator/_common"
cp "$HERE/execute.sh" "$TMP/skills/orchestrator/list-missions/execute.sh"
cat > "$TMP/skills/orchestrator/_common/lib.sh" <<'EOF'
api_call_full() { api_call "$@"; }
api_call() {
  cat <<'JSON'
{"success":true,"data":[
 {"id":"m-company","level":"company","objective":"Q4 stable delivery","status":"active","approval":{"state":"approved"},"keyResults":[]},
 {"id":"m-team","level":"team","objective":"Portal team flow","status":"active","approval":{"state":"pending_approval"},"parentMissionId":"m-company",
  "keyResults":[{"id":"k1","title":"KR1 review backlog","current":3,"target":2,"unit":"tickets","status":"on_track","measurementSource":"skill_output","measurements":[]}]}
]}
JSON
}
EOF
OUT=$(bash "$TMP/skills/orchestrator/list-missions/execute.sh")
check "count" "$(printf '%s' "$OUT" | jq '.count')" "2"
check "pending count" "$(printf '%s' "$OUT" | jq '.pendingApproval')" "1"
check "approval defaulted for legacy" "$(printf '%s' "$OUT" | jq -r '.missions[0].approval')" "approved"
check "KR compacted" "$(printf '%s' "$OUT" | jq -c '.missions[1].keyResults[0]')" '{"title":"KR1 review backlog","current":3,"target":2,"unit":"tickets","status":"on_track","measurementSource":"skill_output"}'
OUT=$(bash "$TMP/skills/orchestrator/list-missions/execute.sh" --pending)
check "--pending filters" "$(printf '%s' "$OUT" | jq -r '.missions | map(.id) | join(",")')" "m-team"
OUT=$(bash "$TMP/skills/orchestrator/list-missions/execute.sh" --full)
check "--full is raw" "$(printf '%s' "$OUT" | jq -r '.success')" "true"
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
