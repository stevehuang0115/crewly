#!/bin/bash
# Tests for agent send-message execute.sh
#
# Runs a COPY of the real execute.sh under a stubbed api_call (the
# set-team-lead / delegate-task pattern), so the script logic is exercised
# verbatim without a backend.
#
# Coverage:
#   1. POSTs to /terminal/<to>/write with mode=message
#   2. a normal write is printed unchanged
#   3. a daily-token-cap hold (202 queued, spendCapped) is reported as
#      queued, not delivered, with a do-not-resend note (#937)
#   4. another queued answer is reported as queued, not delivered
#   5. an HTTP error still fails the skill

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

CALL_LOG=$(mktemp)
RESP_FILE=$(mktemp)
SKILL_PARENT=$(mktemp -d)
trap 'rm -rf "$SKILL_PARENT" "$CALL_LOG" "$RESP_FILE"' EXIT

mkdir -p "$SKILL_PARENT/_common" "$SKILL_PARENT/core/send-message"
REAL_LIB="$(cd "$SCRIPT_DIR/../../.." && pwd)/_common/lib.sh"
cat > "$SKILL_PARENT/_common/lib.sh" <<STUB
source "$REAL_LIB"
api_call() {
  local method="\$1" path="\$2" body="\${3:-}"
  echo "\${method} \${path} \$(printf '%s' "\$body" | jq -c .)" >> "${CALL_LOG}"
  if [ "\$(cat "${RESP_FILE}")" = "FAIL" ]; then
    echo '{"error":true,"status":404,"details":"not found"}' >&2
    return 1
  fi
  cat "${RESP_FILE}"
}
STUB
cp "$SCRIPT_DIR/execute.sh" "$SKILL_PARENT/core/send-message/execute.sh"
RUN="$SKILL_PARENT/core/send-message/execute.sh"

check() {
  local desc="$1" haystack="$2" pattern="$3"
  if printf '%s' "$haystack" | grep -qF -- "$pattern"; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$pattern' in: $haystack)"; FAIL=$((FAIL + 1))
  fi
}

echo "=== agent send-message ==="

> "$CALL_LOG"
echo '{"success":true,"message":"Data written successfully"}' > "$RESP_FILE"
OUT=$(bash "$RUN" --to qa-1 --message "PR #42 is ready" 2>/dev/null)
check "posts to /write in message mode" "$(cat "$CALL_LOG")" 'POST /terminal/qa-1/write {"data":"PR #42 is ready","mode":"message"}'
check "a written message is printed unchanged" "$OUT" '"message":"Data written successfully"'

echo '{"success":true,"queued":true,"spendCapped":true,"message":"[SPEND_CAP] Ella hit its daily token cap (5M tokens); message queued"}' > "$RESP_FILE"
OUT=$(bash "$RUN" --to ella-1 --message "hi" 2>/dev/null)
check "cap hold: reported as not delivered" "$OUT" '"delivered":false'
check "cap hold: keeps queued + spendCapped" "$OUT" '"spendCapped":true'
check "cap hold: names the cap and says not to resend" "$OUT" 'ella-1 has hit its daily token cap'
check "cap hold: do-not-resend" "$OUT" 'Do not resend'

echo '{"success":true,"queued":true,"message":"Message queued until agent is ready"}' > "$RESP_FILE"
OUT=$(bash "$RUN" --to dana-1 --message "hi" 2>/dev/null)
check "other queue: reported as not delivered" "$OUT" '"delivered":false'
check "other queue: generic note" "$OUT" 'your message to dana-1 is queued'

echo 'FAIL' > "$RESP_FILE"
if bash "$RUN" --to ghost --message "hi" >/dev/null 2>&1; then
  echo "  FAIL: an HTTP error must fail the skill"; FAIL=$((FAIL + 1))
else
  echo "  PASS: an HTTP error fails the skill"; PASS=$((PASS + 1))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
