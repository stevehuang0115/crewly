#!/bin/bash
# =============================================================================
# Tests for report-progress: the progress note, and the optional task-timing
# fields (etaMinutes, taskKind) forwarded to POST /task-pool/items/:id/notes.
# `curl` is stubbed on PATH so every case runs offline.
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "  ✓ ${name}"
  else
    FAIL=$((FAIL + 1)); echo "  ✗ ${name}"; echo "    expected: ${expected}"; echo "    actual:   ${actual}"
  fi
}

STUB_DIR="$(mktemp -d)"
cat > "$STUB_DIR/curl" << 'STUB_EOF'
#!/bin/bash
BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) BODY="$2"; shift 2 ;;
    -X|-H|-w) shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\n' "$(printf '%s' "$BODY" | tr '\n' ' ')" >> "$CURL_BODY_LOG"
echo '{"success":true}'
echo "200"
STUB_EOF
chmod +x "$STUB_DIR/curl"
export CREWLY_API_URL="http://stub.invalid"
export PATH="$STUB_DIR:$PATH"

run_skill() {
  CURL_BODY_LOG="$(mktemp)"; export CURL_BODY_LOG
  OUT="$(bash "$SCRIPT_DIR/execute.sh" "$1" </dev/null 2>&1)" || true
  # The shared lib sends a skill-start telemetry request first; the note is the one with an author.
  BODY="$(grep '"author"' "$CURL_BODY_LOG" | head -1 || true)"
  rm -f "$CURL_BODY_LOG"
}

echo "=== report-progress tests ==="

run_skill '{"sessionName":"dev-1","workItemId":"wi-1","progress":10,"current":"Starting"}'
check "a plain note carries no timing fields" "null null" "$(printf '%s' "$BODY" | jq -r '"\(.etaMinutes) \(.taskKind)"')"

run_skill '{"sessionName":"dev-1","workItemId":"wi-1","progress":5,"current":"Starting","etaMinutes":20,"taskKind":"revision"}'
check "etaMinutes is sent as a number" "20" "$(printf '%s' "$BODY" | jq -r '.etaMinutes')"
check "taskKind is sent" "revision" "$(printf '%s' "$BODY" | jq -r '.taskKind')"
check "the note states the ETA" "true" "$(printf '%s' "$BODY" | jq -r '.note | contains("ETA: 20 min (revision)")')"

run_skill '{"sessionName":"dev-1","workItemId":"wi-1","progress":5,"current":"Starting","etaMinutes":"soon"}'
check "a non-numeric ETA is refused" "true" "$(printf '%s' "$OUT" | grep -q 'etaMinutes must be a number' && echo true || echo false)"

rm -rf "$STUB_DIR"
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ]
