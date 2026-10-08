#!/bin/bash
# Tests for TL propose-tier-change execute.sh
# A fake `curl` on PATH records the request body, so the real script (and the
# real lib.sh) run unmodified.
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
method="GET"; body=""; url=""; session=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    -H) case "$2" in "X-Agent-Session: "*) session="${2#X-Agent-Session: }" ;; esac; shift 2 ;;
    -w) shift 2 ;;
    -s) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$method $url" in
  "POST "*/api/teams/model-tiers/proposals)
    printf '%s' "$body" > "$FAKE_CURL_LOG"
    printf '%s' "$session" > "$FAKE_CURL_LOG.session"
    printf '%s\n200' '{"success":true,"data":{"ok":true}}'
    ;;
  *)
    printf '%s\n404' '{"error":"unknown"}'
    ;;
esac
CURL_EOF
chmod +x "$TMP/bin/curl"

run() {
  : > "$TMP/body.json"
  env PATH="$TMP/bin:$PATH" CREWLY_HOME="$TMP/home" CREWLY_SESSION_NAME="tl-session" \
    FAKE_CURL_LOG="$TMP/body.json" bash "$EXECUTE" "$@"
}

check() {
  local desc="$1" ok="$2"
  if [ "$ok" = "yes" ]; then echo "  PASS: $desc"; PASS=$((PASS + 1)); else echo "  FAIL: $desc"; FAIL=$((FAIL + 1)); fi
}

echo "=== TL propose-tier-change tests ==="

OUT=$(run --member "Ella" --tier Weak --reason "polls only" 2>&1) && RC=0 || RC=$?
check "member change: succeeds" "$([ "$RC" = 0 ] && echo yes || echo no)"
check "member change: posts member/tier/reason" "$([ "$(jq -c . "$TMP/body.json")" = '{"member":"Ella","tier":"weak","reason":"polls only"}' ] && echo yes || echo no)"
check "member change: sent as the lead" "$([ "$(cat "$TMP/body.json.session")" = "tl-session" ] && echo yes || echo no)"

OUT=$(run --routing "polling -> Ella" 2>&1) && RC=0 || RC=$?
check "routing: posts the rule" "$([ "$RC" = 0 ] && [ "$(jq -r .routing "$TMP/body.json")" = "polling -> Ella" ] && echo yes || echo no)"

OUT=$(run --submit 2>&1) && RC=0 || RC=$?
check "submit: posts submit:true" "$([ "$RC" = 0 ] && [ "$(jq -r .submit "$TMP/body.json")" = "true" ] && echo yes || echo no)"

OUT=$(run '{"clear":true}' 2>&1) && RC=0 || RC=$?
check "json clear: posts clear:true" "$([ "$RC" = 0 ] && [ "$(jq -r .clear "$TMP/body.json")" = "true" ] && echo yes || echo no)"

OUT=$(run --member "Ella" --tier super --reason "x" 2>&1) && RC=0 || RC=$?
check "invalid tier: fails without a request" "$([ "$RC" != 0 ] && [ ! -s "$TMP/body.json" ] && echo "$OUT" | grep -q "Invalid tier" && echo yes || echo no)"

OUT=$(run --member "Ella" --tier weak 2>&1) && RC=0 || RC=$?
check "missing reason: fails" "$([ "$RC" != 0 ] && echo "$OUT" | grep -q "Missing required parameter: reason" && echo yes || echo no)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
