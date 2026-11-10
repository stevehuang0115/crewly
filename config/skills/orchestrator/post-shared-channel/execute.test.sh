#!/bin/bash
# Tests for post-shared-channel: request building and argument handling.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
assert_eq() { if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2', got '$3'"; FAIL=$((FAIL+1)); fi; }
assert_contains() { if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi; }

export CREWLY_SKILL_DRY_RUN=1
run() { bash "$SCRIPT_DIR/execute.sh" "$@" </dev/null 2>&1 || true; }

assert_eq "basic send" 'POST /shared-channels/lnk_1/messages {"message":"hello"}' "$(run --link lnk_1 --message hello)"
assert_eq "list" 'GET /shared-channels' "$(run --list)"

OUT=$(run --link lnk_1 --reply-to msg-abc --message "yes")
assert_contains "reply-to carried" '"replyTo":"msg-abc"' "$OUT"

OUT=$(run --link lnk_1 --message 'quote " and $dollar and `tick`')
assert_contains "special characters survive" 'quote \" and $dollar and `tick`' "$OUT"

OUT=$(echo "from stdin" | bash "$SCRIPT_DIR/execute.sh" --link lnk_1 2>&1 || true)
assert_contains "message from stdin" '"message":"from stdin"' "$OUT"

TMP=$(mktemp); printf 'from file' > "$TMP"
OUT=$(run --link lnk_1 --message-file "$TMP"); rm -f "$TMP"
assert_contains "message from file" '"message":"from file"' "$OUT"

assert_contains "missing --link is an error" 'link' "$(run --message hi)"
assert_contains "missing message is an error" 'message' "$(run --link lnk_1)"
assert_contains "a link id with a slash is refused" 'Invalid link id' "$(run --link ../x --message hi)"
assert_contains "flag without value is an error" 'needs a value' "$(run --link)"
assert_contains "--help prints usage" 'Usage:' "$(run --help)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
