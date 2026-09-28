#!/bin/bash
# Tests for TL set-member-model execute.sh
# A fake `curl` on PATH answers the team lookup and records the PATCH body,
# so the real script (and the real lib.sh) run unmodified.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE="$SCRIPT_DIR/execute.sh"
PASS=0
FAIL=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" << 'CURL_EOF'
#!/bin/bash
# Fake curl: args end with the URL; -X gives the method, -d the body.
method="GET"; body=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    -H|-w) shift 2 ;;
    -s) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$method $url" in
  "GET "*/api/teams/team-123)
    printf '%s\n200' '{"success":true,"data":{"id":"team-123","members":[{"id":"tl-001","parentMemberId":""},{"id":"worker-001","parentMemberId":"tl-001"},{"id":"worker-002","parentMemberId":"other-tl"}]}}'
    ;;
  "PATCH "*/api/teams/team-123/members/*)
    printf '%s' "$body" > "$FAKE_CURL_LOG"
    printf '%s\n200' '{"success":true}'
    ;;
  *)
    printf '%s\n404' '{"error":"unknown"}'
    ;;
esac
CURL_EOF
chmod +x "$TMP/bin/curl"

run() {
  : > "$TMP/patch.json"
  env PATH="$TMP/bin:$PATH" CREWLY_HOME="$TMP/home" CREWLY_SESSION_NAME="tl-session" \
    FAKE_CURL_LOG="$TMP/patch.json" bash "$EXECUTE" "$1"
}

check() {
  local desc="$1" ok="$2"
  if [ "$ok" = "yes" ]; then echo "  PASS: $desc"; PASS=$((PASS + 1)); else echo "  FAIL: $desc"; FAIL=$((FAIL + 1)); fi
}

echo "=== TL set-member-model tests ==="

OUT=$(run '{"teamId":"team-123","memberId":"worker-001","tlMemberId":"tl-001","model":"opus"}' 2>&1) && RC=0 || RC=$?
check "opus: succeeds" "$([ "$RC" = 0 ] && echo yes || echo no)"
check "opus: PATCHes modelId=opus" "$([ "$(jq -r .modelId "$TMP/patch.json")" = "opus" ] && echo yes || echo no)"

OUT=$(run '{"teamId":"team-123","memberId":"worker-001","tlMemberId":"tl-001","model":"Sonnet"}' 2>&1) && RC=0 || RC=$?
check "sonnet (any case): PATCHes modelId=sonnet" "$([ "$RC" = 0 ] && [ "$(jq -r .modelId "$TMP/patch.json")" = "sonnet" ] && echo yes || echo no)"

OUT=$(run '{"teamId":"team-123","memberId":"worker-001","tlMemberId":"tl-001","model":"default"}' 2>&1) && RC=0 || RC=$?
check "default: PATCHes modelId='' (clears the override)" "$([ "$RC" = 0 ] && [ "$(jq -r .modelId "$TMP/patch.json")" = "" ] && echo yes || echo no)"

OUT=$(run '{"teamId":"team-123","memberId":"worker-001","tlMemberId":"tl-001","model":"gpt-9"}' 2>&1) && RC=0 || RC=$?
check "invalid model: fails without PATCH" "$([ "$RC" != 0 ] && [ ! -s "$TMP/patch.json" ] && echo "$OUT" | grep -q "Invalid model" && echo yes || echo no)"

OUT=$(run '{"teamId":"team-123","memberId":"worker-002","tlMemberId":"tl-001","model":"opus"}' 2>&1) && RC=0 || RC=$?
check "non-subordinate: hierarchy violation, no PATCH" "$([ "$RC" != 0 ] && [ ! -s "$TMP/patch.json" ] && echo "$OUT" | grep -q "Hierarchy violation" && echo yes || echo no)"

OUT=$(run '{"teamId":"team-123","memberId":"worker-001","tlMemberId":"tl-001"}' 2>&1) && RC=0 || RC=$?
check "missing model: fails" "$([ "$RC" != 0 ] && echo "$OUT" | grep -q "Missing required parameter: model" && echo yes || echo no)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
