#!/bin/bash
# Tests for screenshot-compare's Gemini key lookup — run with: bash execute.test.sh </dev/null
# A fake curl on an isolated PATH plays both the Crewly backend and Gemini, so
# nothing reaches the network. Exit 0 on pass.
#
# Without GEMINI_API_KEY the skill asks Crewly's key route with the agent badge
# (#1012). It used to read GET /api/settings, which masks keys, so it sent the
# mask to Gemini.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

JQ="$(command -v jq)"
BASH_BIN="${TEST_BASH:-$(command -v bash)}"
[ -n "$JQ" ] || { echo "jq is required to run these tests"; exit 1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home"
for tool in bash jq cat rm tr base64 date grep head; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$T/bin/$tool"
done
printf 'png' > "$T/ref.png"
printf 'png' > "$T/web.png"

cat > "$T/bin/curl" <<'FAKECURL'
#!/bin/bash
printf '%s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *"/api/settings/api-key/gemini"*)
    case "$*" in *"X-Agent-Badge: badge-for-sam"*) printf '{"success":true,"data":{"provider":"gemini","key":"AIza-from-crewly-8888"}}' ;; *) exit 22 ;; esac ;;
  *"/api/settings"*)
    printf '{"success":true,"data":{"apiKeys":{"global":{"gemini":"••••••••8888"}}}}' ;;
  *"generativelanguage.googleapis.com"*)
    printf '{"candidates":[{"content":{"parts":[{"text":"{\\"differences\\":[]}"}]}}]}' ;;
  *) exit 7 ;;
esac
FAKECURL
chmod 755 "$T/bin/curl"

run() {
  env -i HOME="$T/home" PATH="$T/bin" CREWLY_API_URL="http://127.0.0.1:9" CURL_LOG="$T/curl.log" \
    CREWLY_SESSION_NAME="crewly-dev-sam" CREWLY_AGENT_BADGE="$1" \
    "$BASH_BIN" "$EXEC" "{\"reference\":\"$T/ref.png\",\"target\":\"$T/web.png\"}" 2>/dev/null </dev/null
}

# 1. With the badge: the key comes from the key route and reaches Gemini.
: > "$T/curl.log"
OUT=$(run "badge-for-sam"); RC=$?
check "badge: exit 0" "$RC" "0"
check "badge: success" "$(printf '%s' "$OUT" | "$JQ" -r .success)" "true"
check "badge: asked the key route for this skill" "$(grep -c '/api/settings/api-key/gemini?skill=screenshot-compare' "$T/curl.log")" "1"
check "badge: sent the badge" "$(grep -c 'X-Agent-Badge: badge-for-sam' "$T/curl.log")" "1"
check "badge: real key sent to Gemini" "$(grep -c 'key=AIza-from-crewly-8888' "$T/curl.log")" "1"
check "badge: never sent a mask" "$(grep -c '••••' "$T/curl.log")" "0"

# 2. Without a badge the route refuses: a clear error, Gemini never called.
: > "$T/curl.log"
OUT=$(run ""); RC=$?
check "no badge: exit 1" "$RC" "1"
check "no badge: error names the key" "$(printf '%s' "$OUT" | "$JQ" -r '.error | test("GEMINI_API_KEY not set")')" "true"
check "no badge: Gemini not called" "$(grep -c 'generativelanguage' "$T/curl.log")" "0"

# 3. GEMINI_API_KEY in the environment still wins; Crewly is not asked.
: > "$T/curl.log"
OUT=$(env -i HOME="$T/home" PATH="$T/bin" CREWLY_API_URL="http://127.0.0.1:9" CURL_LOG="$T/curl.log" GEMINI_API_KEY="AIza-env-9999" \
  "$BASH_BIN" "$EXEC" "{\"reference\":\"$T/ref.png\",\"target\":\"$T/web.png\"}" 2>/dev/null </dev/null); RC=$?
check "env key: exit 0" "$RC" "0"
check "env key: Crewly not asked" "$(grep -c '/api/settings' "$T/curl.log")" "0"
check "env key: used" "$(grep -c 'key=AIza-env-9999' "$T/curl.log")" "1"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
