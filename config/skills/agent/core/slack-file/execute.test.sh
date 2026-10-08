#!/bin/bash
# Tests for slack-file: argument parsing, request body, --out copy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
assert_eq() { if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2', got '$3'"; FAIL=$((FAIL+1)); fi; }
assert_contains() { if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi; }

LINK='https://acme.slack.com/files/U0ELLA1234/F0ABC12345/longform-en.md'
assert_eq "get <link> → POST with fileRef" "POST /slack/files/fetch {\"fileRef\":\"$LINK\"}" "$(CREWLY_SKILL_DRY_RUN=1 bash "$SCRIPT_DIR/execute.sh" get "$LINK")"
assert_eq "get <id>" 'POST /slack/files/fetch {"fileRef":"F0ABC12345"}' "$(CREWLY_SKILL_DRY_RUN=1 bash "$SCRIPT_DIR/execute.sh" get F0ABC12345)"
assert_eq "quotes in the ref stay JSON-safe" 'POST /slack/files/fetch {"fileRef":"F0\"x"}' "$(CREWLY_SKILL_DRY_RUN=1 bash "$SCRIPT_DIR/execute.sh" get 'F0"x')"
assert_contains "missing ref → usage error" "Usage" "$(bash "$SCRIPT_DIR/execute.sh" get 2>&1 || true)"
assert_contains "--help prints usage" "slack-file" "$(bash "$SCRIPT_DIR/execute.sh" --help)"

# --out copies the saved file and reports the new path (api_call stubbed).
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf 'hello\n' > "$TMP/saved.md"
STUB="$TMP/stub-lib.sh"
cat > "$STUB" <<STUB_EOF
api_call() { printf '%s' '{"success":true,"data":{"path":"$TMP/saved.md","file":{"name":"longform-en.md","mimetype":"text/markdown","size":6,"via":"cloud:agent:team-ella"},"preview":"hello"}}'; }
STUB_EOF
mkdir -p "$TMP/skills/agent/core/slack-file" "$TMP/skills/agent/_common"
cp "$SCRIPT_DIR/execute.sh" "$TMP/skills/agent/core/slack-file/execute.sh"
cp "$STUB" "$TMP/skills/agent/_common/lib.sh"
OUT_JSON="$(bash "$TMP/skills/agent/core/slack-file/execute.sh" get "$LINK" --out "$TMP/out/longform-en.md")"
assert_eq "--out path reported" "$TMP/out/longform-en.md" "$(printf '%s' "$OUT_JSON" | jq -r .path)"
assert_eq "--out file copied" "hello" "$(cat "$TMP/out/longform-en.md")"
assert_eq "preview passed through" "hello" "$(printf '%s' "$OUT_JSON" | jq -r .preview)"
assert_eq "via passed through" "cloud:agent:team-ella" "$(printf '%s' "$OUT_JSON" | jq -r .via)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
