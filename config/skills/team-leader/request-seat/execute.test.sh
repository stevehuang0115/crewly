#!/bin/bash
# Tests for TL request-seat execute.sh
# A fake `curl` on PATH records the request, so the real script (and the
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
  "POST "*/api/teams/*/seat-requests*)
    printf '%s' "$body" > "$FAKE_CURL_LOG"
    printf '%s' "$session" > "$FAKE_CURL_LOG.session"
    printf '%s' "${url#*/api}" > "$FAKE_CURL_LOG.path"
    if [ -n "${FAKE_CURL_REFUSE:-}" ]; then
      printf '%s\n409' '{"success":false,"error":"refused for the test","code":"test_refusal"}'
    else
      printf '%s\n200' '{"success":true,"data":{"ok":true}}'
    fi
    ;;
  *)
    printf '%s\n404' '{"error":"unknown"}'
    ;;
esac
CURL_EOF
chmod +x "$TMP/bin/curl"
# The lead's own team, found from its session when --team is not given.
mkdir -p "$TMP/home/.crewly/teams/team-own"
printf '%s' '{"id":"team-own","members":[{"id":"m-lead","sessionName":"tl-session"}]}' > "$TMP/home/.crewly/teams/team-own/config.json"

run() {
  : > "$TMP/body.json"; : > "$TMP/body.json.path"
  env PATH="$TMP/bin:$PATH" HOME="$TMP/home" CREWLY_HOME="$TMP/home/.crewly" CREWLY_SESSION_NAME="${SESSION-tl-session}" \
    FAKE_CURL_LOG="$TMP/body.json" FAKE_CURL_REFUSE="${REFUSE:-}" bash "$EXECUTE" "$@"
}

check() {
  local desc="$1" ok="$2"
  if [ "$ok" = "yes" ]; then echo "  PASS: $desc"; PASS=$((PASS + 1)); else echo "  FAIL: $desc"; FAIL=$((FAIL + 1)); fi
}

echo "=== TL request-seat tests ==="

OUT=$(run --role developer --reason "second developer every week" 2>&1) && RC=0 || RC=$?
check "minimal: succeeds" "$([ "$RC" = 0 ] && echo yes || echo no)"
check "minimal: posts role and reason only" "$([ "$(jq -c . "$TMP/body.json")" = '{"role":"developer","reason":"second developer every week"}' ] && echo yes || echo no)"
check "minimal: goes to the lead's own team" "$([ "$(cat "$TMP/body.json.path")" = "/teams/team-own/seat-requests" ] && echo yes || echo no)"
check "minimal: sent as the lead" "$([ "$(cat "$TMP/body.json.session")" = "tl-session" ] && echo yes || echo no)"

OUT=$(run --team team-9 --role designer --reason "images" --name "Kai" 2>&1) && RC=0 || RC=$?
check "full: posts the name, --team wins" "$([ "$RC" = 0 ] && [ "$(jq -c . "$TMP/body.json")" = '{"role":"designer","reason":"images","name":"Kai"}' ] && [ "$(cat "$TMP/body.json.path")" = "/teams/team-9/seat-requests" ] && echo yes || echo no)"

OUT=$(run '{"role":"qa","reason":"release week","teamId":"team-3"}' 2>&1) && RC=0 || RC=$?
check "json: same request" "$([ "$RC" = 0 ] && [ "$(jq -c . "$TMP/body.json")" = '{"role":"qa","reason":"release week"}' ] && [ "$(cat "$TMP/body.json.path")" = "/teams/team-3/seat-requests" ] && echo yes || echo no)"

OUT=$(run --role developer 2>&1) && RC=0 || RC=$?
check "missing reason: fails without a request" "$([ "$RC" != 0 ] && [ ! -s "$TMP/body.json.path" ] && echo "$OUT" | grep -q "Missing required parameter: reason" && echo yes || echo no)"

OUT=$(REFUSE=1 run --role developer --reason "x" 2>&1) && RC=0 || RC=$?
check "refusal (e.g. declined 14 days ago): fails and shows the server's message" "$([ "$RC" != 0 ] && echo "$OUT" | grep -q "refused for the test" && echo yes || echo no)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
