#!/bin/bash
# Tests for ORC move-team-member execute.sh
#
# Runs a COPY of the real execute.sh under a stubbed api_call, so the lookup
# logic is exercised verbatim without a backend.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

CALL_LOG=$(mktemp)
OUT=$(mktemp)
SKILL_PARENT=$(mktemp -d)
trap 'rm -rf "$SKILL_PARENT" "$CALL_LOG" "$OUT"' EXIT

mkdir -p "$SKILL_PARENT/_common" "$SKILL_PARENT/move-team-member"
REAL_LIB="$(cd "$SCRIPT_DIR/../.." && pwd)/_common/lib.sh"
cat > "$SKILL_PARENT/_common/lib.sh" <<STUB
source "$REAL_LIB"
api_call() {
  local method="\$1" path="\$2" body="\${3:-}"
  if [ "\$method" = "GET" ]; then
    echo '{"success":true,"data":[
      {"id":"t-core","name":"Core","members":[{"id":"m1","name":"Nova","sessionName":"core-nova-1"},{"id":"m2","name":"Kai","sessionName":""}]},
      {"id":"t-growth","name":"Growth Team","members":[{"id":"m3","name":"Kai","sessionName":"growth-kai-3"}]}
    ]}' | jq -c .
    return 0
  fi
  echo "\${method} \${path} \$(printf '%s' "\$body" | jq -c .)" >> "${CALL_LOG}"
  echo '{"success":true,"data":{"member":{"name":"Nova","sessionName":"core-nova-1"},"from":{"name":"Core"},"to":{"name":"Growth Team"},"restartRequired":true,"updated":{"workItems":["a","b"],"triggers":[],"cronTasks":["c"],"decisions":[]},"warnings":[]}}'
}
STUB
cp "$SCRIPT_DIR/execute.sh" "$SKILL_PARENT/move-team-member/execute.sh"
RUN="$SKILL_PARENT/move-team-member/execute.sh"

check() {
  local desc="$1" pattern="$2" file="${3:-$CALL_LOG}"
  if grep -qF -- "$pattern" "$file"; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$pattern')"; sed 's/^/    /' "$file"; FAIL=$((FAIL + 1))
  fi
}
run() { : > "$CALL_LOG"; : > "$OUT"; bash "$RUN" "$@" >"$OUT" 2>&1 || true; }
check_no_call() {
  if [ -s "$CALL_LOG" ]; then
    echo "  FAIL: $1 (expected no move call)"; sed 's/^/    /' "$CALL_LOG"; FAIL=$((FAIL + 1))
  else
    echo "  PASS: $1"; PASS=$((PASS + 1))
  fi
}

echo "=== ORC move-team-member ==="

run --member core-nova-1 --to t-growth
check "session name and team id" 'POST /teams/t-core/members/m1/move {"toTeamId":"t-growth","allowLead":false}'
check "says what moved and what changed" 'Moved Nova (core-nova-1) from Core to Growth Team. Updated: 2 work item(s), 0 followup(s), 1 cron task(s), 0 open decision(s). Restart the agent' "$OUT"

run --member nova --to "growth team" --allow-lead
check "names are case-insensitive; --allow-lead is sent" 'POST /teams/t-core/members/m1/move {"toTeamId":"t-growth","allowLead":true}'

run '{"member":"Kai","from":"Core","to":"Growth Team"}'
check "JSON form; --from picks between two members of the same name" 'POST /teams/t-core/members/m2/move'

run --member Kai --to t-growth
check_no_call "an ambiguous name makes no move"
check "and lists the choices" 'Kai on Core (m2); Kai on Growth Team (growth-kai-3)' "$OUT"

run --member Nobody --to t-growth
check_no_call "an unknown member makes no move"

run --member Nova --to Nowhere
check_no_call "an unknown target makes no move"

run --member Nova --to Core
check_no_call "the team it is on makes no move"

run --member Nova --to t-growth --from "Growth Team"
check_no_call "a --from that does not hold the member makes no move"

run --member Nova
check_no_call "missing --to makes no call"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
