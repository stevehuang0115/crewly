#!/bin/bash
# Tests for ORC set-team-lead execute.sh
#
# Runs a COPY of the real execute.sh under a stubbed api_call (the
# render-verdict / delegate-task pattern), so the script logic is exercised
# verbatim without a backend.
#
# Coverage:
#   1. flag form POSTs to /teams/<team>/lead with member + mode=set
#   2. team names are URL-encoded ("Think Tank" → Think%20Tank)
#   3. --add sends mode=add
#   4. JSON form works
#   5. missing --member / bad mode are rejected BEFORE any HTTP call

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

CALL_LOG=$(mktemp)
SKILL_PARENT=$(mktemp -d)
trap 'rm -rf "$SKILL_PARENT" "$CALL_LOG"' EXIT

mkdir -p "$SKILL_PARENT/_common" "$SKILL_PARENT/set-team-lead"
REAL_LIB="$(cd "$SCRIPT_DIR/../.." && pwd)/_common/lib.sh"
cat > "$SKILL_PARENT/_common/lib.sh" <<STUB
source "$REAL_LIB"
api_call() {
  local method="\$1" path="\$2" body="\${3:-}"
  echo "\${method} \${path} \$(printf '%s' "\$body" | jq -c .)" >> "${CALL_LOG}"
  echo '{"success":true,"data":{"teamName":"CE","leads":["Owen"]}}'
}
STUB
cp "$SCRIPT_DIR/execute.sh" "$SKILL_PARENT/set-team-lead/execute.sh"
chmod +x "$SKILL_PARENT/set-team-lead/execute.sh"
RUN="$SKILL_PARENT/set-team-lead/execute.sh"

check() {
  local desc="$1" pattern="$2"
  if grep -qF -- "$pattern" "$CALL_LOG"; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$pattern')"; sed 's/^/    /' "$CALL_LOG"; FAIL=$((FAIL + 1))
  fi
}
check_empty() {
  local desc="$1"
  if [ -s "$CALL_LOG" ]; then
    echo "  FAIL: $desc (expected no api_call)"; sed 's/^/    /' "$CALL_LOG"; FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  fi
}

echo "=== ORC set-team-lead ==="

> "$CALL_LOG"; bash "$RUN" --team CE --member Owen >/dev/null 2>&1 || true
check "flag form posts to the lead endpoint" 'POST /teams/CE/lead {"member":"Owen","mode":"set"}'

> "$CALL_LOG"; bash "$RUN" --team "Think Tank" --member ce-owen-a1b2c3d4 >/dev/null 2>&1 || true
check "team name is URL-encoded" 'POST /teams/Think%20Tank/lead {"member":"ce-owen-a1b2c3d4","mode":"set"}'

> "$CALL_LOG"; bash "$RUN" --team CE --member Vera --add >/dev/null 2>&1 || true
check "--add sends mode=add" '{"member":"Vera","mode":"add"}'

> "$CALL_LOG"; bash "$RUN" '{"team":"CE","member":"Owen"}' >/dev/null 2>&1 || true
check "JSON form works" 'POST /teams/CE/lead {"member":"Owen","mode":"set"}'

> "$CALL_LOG"; bash "$RUN" --team CE >/dev/null 2>&1 || true
check_empty "missing member makes no call"

> "$CALL_LOG"; bash "$RUN" '{"team":"CE","member":"Owen","mode":"remove"}' >/dev/null 2>&1 || true
check_empty "an unknown mode makes no call"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
