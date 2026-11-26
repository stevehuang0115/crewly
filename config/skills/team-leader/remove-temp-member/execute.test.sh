#!/bin/bash
# Tests for TL remove-temp-member execute.sh
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
  "DELETE "*/api/teams/*/temp-members/*)
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

echo "=== TL remove-temp-member tests ==="

OUT=$(run --member "Temp-Developer-1" 2>&1) && RC=0 || RC=$?
check "by name: succeeds" "$([ "$RC" = 0 ] && echo yes || echo no)"
check "by name: DELETE on the lead's own team" "$([ "$(cat "$TMP/body.json.path")" = "/teams/team-own/temp-members/Temp-Developer-1" ] && echo yes || echo no)"
check "by name: not forced" "$([ "$(jq -c . "$TMP/body.json")" = '{"force":false}' ] && echo yes || echo no)"
check "by name: sent as the lead" "$([ "$(cat "$TMP/body.json.session")" = "tl-session" ] && echo yes || echo no)"

OUT=$(run --team team-9 --member "Kai Lee" --reason "launch moved" --force 2>&1) && RC=0 || RC=$?
check "full: name is URL-encoded" "$([ "$RC" = 0 ] && [ "$(cat "$TMP/body.json.path")" = "/teams/team-9/temp-members/Kai%20Lee" ] && echo yes || echo no)"
check "full: posts reason and force" "$([ "$(jq -c . "$TMP/body.json")" = '{"force":true,"reason":"launch moved"}' ] && echo yes || echo no)"

OUT=$(run '{"member":"member-1","force":true}' 2>&1) && RC=0 || RC=$?
check "json: same request" "$([ "$RC" = 0 ] && [ "$(jq -r .force "$TMP/body.json")" = "true" ] && [ "$(cat "$TMP/body.json.path")" = "/teams/team-own/temp-members/member-1" ] && echo yes || echo no)"

OUT=$(run --reason "x" 2>&1) && RC=0 || RC=$?
check "missing member: fails without a request" "$([ "$RC" != 0 ] && [ ! -s "$TMP/body.json.path" ] && echo "$OUT" | grep -q "Missing required parameter: member" && echo yes || echo no)"

OUT=$(REFUSE=1 run --member "Ella" 2>&1) && RC=0 || RC=$?
check "refusal: fails and shows the server's message" "$([ "$RC" != 0 ] && echo "$OUT" | grep -q "refused for the test" && echo yes || echo no)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
