#!/bin/bash
# Tests for list-colleagues: endpoint selection with/without --channel.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
assert_eq() { if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2', got '$3'"; FAIL=$((FAIL+1)); fi; }
assert_contains() { if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi; }

export CREWLY_SKILL_DRY_RUN=1
assert_eq "no channel → account directory" "GET /slack/directory" "$(bash "$SCRIPT_DIR/execute.sh")"
assert_eq "channel is passed sanitised" "GET /slack/directory?channel=C0ABC12rmrf" "$(bash "$SCRIPT_DIR/execute.sh" --channel 'C0ABC12;rm -rf /')"
assert_contains "--help prints usage" "Usage:" "$(bash "$SCRIPT_DIR/execute.sh" --help)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
