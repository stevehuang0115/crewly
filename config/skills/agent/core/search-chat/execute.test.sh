#!/bin/bash
# Tests for search-chat: argument handling and the endpoint it builds.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
assert_eq() { if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2', got '$3'"; FAIL=$((FAIL+1)); fi; }
assert_contains() { if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi; }

export CREWLY_SKILL_DRY_RUN=1
assert_eq "keywords only" "GET /chat/search?q=video%20plan" "$(bash "$SCRIPT_DIR/execute.sh" --query 'video plan')"
assert_eq "channel and dates" "GET /chat/search?q=video&channel=%23awesome-videos&from=2026-10-09&to=2026-10-09&limit=5" \
  "$(bash "$SCRIPT_DIR/execute.sh" --query video --channel '#awesome-videos' --from 2026-10-09 --to 2026-10-09 --limit 5)"
assert_eq "CJK keywords are encoded" "GET /chat/search?q=%E8%A7%86%E9%A2%91" "$(bash "$SCRIPT_DIR/execute.sh" --query 视频)"
assert_eq "JSON argument" "GET /chat/search?q=TKT-401&limit=8" "$(bash "$SCRIPT_DIR/execute.sh" '{"query":"TKT-401","limit":8}')"
assert_eq "JSON with every field" "GET /chat/search?q=video%20plan&channel=%23awesome-videos&from=2026-10-01&to=2026-10-09&limit=3" \
  "$(bash "$SCRIPT_DIR/execute.sh" '{"query":"video plan","channel":"#awesome-videos","from":"2026-10-01","to":"2026-10-09","limit":3}')"
assert_eq "flags override JSON" "GET /chat/search?q=b&limit=2" "$(bash "$SCRIPT_DIR/execute.sh" '{"query":"a","limit":8}' --query b --limit 2)"
assert_contains "JSON without query is an error" "--query is required" "$(bash "$SCRIPT_DIR/execute.sh" '{"limit":3}' 2>&1 || true)"
assert_contains "missing --query is an error" "--query is required" "$(bash "$SCRIPT_DIR/execute.sh" 2>&1 || true)"
assert_contains "bad --limit is an error" "--limit must be a number" "$(bash "$SCRIPT_DIR/execute.sh" --query x --limit abc 2>&1 || true)"
assert_contains "--help prints usage" "Usage:" "$(bash "$SCRIPT_DIR/execute.sh" --help)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
