#!/bin/bash
# Tests for the orchestrator send-message skill.
#
# Guards the input forms the orchestrator prompt teaches: JSON with
# `sessionName` (canonical), JSON with `to` (older examples), and the CLI
# flag form from the Gemini safe-call guide. `curl` is stubbed on PATH, so
# every case runs offline and records the real request the skill issues.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

check() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1)); echo "  ✓ ${name}"
  else
    FAIL=$((FAIL + 1)); echo "  ✗ ${name}"; echo "    expected to contain: ${needle}"; echo "    actual: ${haystack}"
  fi
}

STUB_DIR="$(mktemp -d)"
cat > "$STUB_DIR/curl" << 'STUB_EOF'
#!/bin/bash
URL=""; BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) BODY="$2"; shift 2 ;;
    -X|-H|-w) shift 2 ;;
    -s) shift ;;
    *) URL="$1"; shift ;;
  esac
done
printf '%s %s\n' "$URL" "$(printf '%s' "$BODY" | tr -d '\n ')" >> "$CURL_LOG"
case "$URL" in
  */deliver) printf '%s\n%s' "${STUB_BODY:-{\"success\":true\}}" "${STUB_CODE:-200}" ;;
  *) printf '{"success":true}\n200' ;;
esac
STUB_EOF
chmod +x "$STUB_DIR/curl"
export PATH="$STUB_DIR:$PATH" CREWLY_API_URL="http://stub.invalid" CREWLY_SESSION_NAME="crewly-orc"

# Runs the skill; sets OUT (stdout+stderr) and REQ (requests sent).
run() {
  CURL_LOG="$(mktemp)"; export CURL_LOG
  OUT="$(bash "$SCRIPT_DIR/execute.sh" "$@" </dev/null 2>&1)" || true
  REQ="$(cat "$CURL_LOG")"; rm -f "$CURL_LOG"
}

echo "=== orchestrator send-message tests ==="

run '{"sessionName":"dev-1","message":"hi"}'
check "sessionName JSON reaches /deliver for that session" "http://stub.invalid/api/terminal/dev-1/deliver" "$REQ"
check "readiness-aware delivery by default" '"waitForReady":true' "$REQ"
check "never waits more than 10 s for the recipient" '"waitTimeout":10000' "$REQ"
check "asks the backend to queue for a busy recipient" '"queueIfBusy":true' "$REQ"

STUB_BODY='{"success":true,"queued":true,"verified":false,"position":2,"queueSize":3}' STUB_CODE=202 run '{"sessionName":"dev-1","message":"hi"}'
check "a queued answer says it was not delivered yet" '"delivered":false' "$OUT"
check "a queued answer gives the queue position" '(position 2)' "$OUT"
check "a queued answer tells the caller not to wait" 'do not wait for it' "$OUT"

run '{"to":"dev-2","message":"hi"}'
check "'to' is accepted as an alias for sessionName" "/api/terminal/dev-2/deliver" "$REQ"

run --to dev-3 --message "hello there"
check "--to/--message flags work" "/api/terminal/dev-3/deliver" "$REQ"
check "flag message is sent" '"message":"hellothere"' "$REQ"

run --session dev-4 --message hi --force
check "--session and --force flags work" "/api/terminal/dev-4/deliver" "$REQ"
check "--force sends force:true" '"force":true' "$REQ"

run '{"message":"no target"}'
check "missing session is reported" "sessionName" "$OUT"
# (lib.sh sends a skill-start heartbeat; what must not happen is a delivery.)
if printf '%s' "$REQ" | grep -q "/deliver"; then
  FAIL=$((FAIL + 1)); echo "  ✗ missing session must not deliver anything"
else
  PASS=$((PASS + 1)); echo "  ✓ missing session delivers nothing"
fi

run --to
check "--to with no value names the flag" "Flag --to needs a value" "$OUT"

run --to dev-5 --message
check "--message with no value names the flag" "Flag --message needs a value" "$OUT"

run --to --message hi
check "--to followed by another flag is refused" "Flag --to needs a value" "$OUT"

run --bogus x
check "unknown flag is refused" "Unknown option: --bogus" "$OUT"

rm -rf "$STUB_DIR"
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ]
