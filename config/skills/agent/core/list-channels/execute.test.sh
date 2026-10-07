#!/bin/bash
# Tests for list-channels: endpoint selection (own channels vs --all).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
assert_eq() { if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2', got '$3'"; FAIL=$((FAIL+1)); fi; }
assert_contains() { if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi; }

export CREWLY_SKILL_DRY_RUN=1
assert_eq "own channels by session" "GET /channels?member=research-ella" "$(CREWLY_SESSION_NAME=research-ella bash "$SCRIPT_DIR/execute.sh")"
assert_eq "session is sanitised" "GET /channels?member=evilrm-rf" "$(CREWLY_SESSION_NAME='evil;rm -rf' bash "$SCRIPT_DIR/execute.sh")"
assert_eq "--all lists every channel" "GET /channels" "$(CREWLY_SESSION_NAME=x bash "$SCRIPT_DIR/execute.sh" --all)"
assert_contains "no session and no --all → error" "CREWLY_SESSION_NAME is not set" "$(env -u CREWLY_SESSION_NAME bash "$SCRIPT_DIR/execute.sh" 2>&1 || true)"
assert_contains "--help prints usage" "Usage:" "$(bash "$SCRIPT_DIR/execute.sh" --help)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
