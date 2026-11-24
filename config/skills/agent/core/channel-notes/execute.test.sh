#!/bin/bash
# Tests for channel-notes: endpoint and body building.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
assert_eq() { if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2', got '$3'"; FAIL=$((FAIL+1)); fi; }
assert_contains() { if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi; }

export CREWLY_SKILL_DRY_RUN=1
export CREWLY_SESSION_NAME=flopost-pia
assert_eq "read by id" "GET /channel-notes/room-1" "$(bash "$SCRIPT_DIR/execute.sh" --channel room-1 </dev/null)"
assert_eq "read by name is URL-encoded" "GET /channel-notes/%23necina" "$(bash "$SCRIPT_DIR/execute.sh" --channel '#necina' </dev/null)"
assert_eq "record the lead" 'POST /channel-notes/room-1 {"lead":"Atlas"}' "$(bash "$SCRIPT_DIR/execute.sh" --channel room-1 --lead Atlas </dev/null)"
assert_eq "clear the lead" 'POST /channel-notes/room-1 {"lead":""}' "$(bash "$SCRIPT_DIR/execute.sh" --channel room-1 --lead '' </dev/null)"
assert_eq "cover line with quotes" 'POST /channel-notes/room-1 {"cover":"Atlas: the \"Saturday\" talk"}' "$(bash "$SCRIPT_DIR/execute.sh" --channel room-1 --cover 'Atlas: the "Saturday" talk' </dev/null)"
TMP="$(mktemp)"; printf 'Decided: three parts.\nOpen: slides.' > "$TMP"
assert_contains "notes from a file" '"notes":"Decided: three parts.\nOpen: slides."' "$(bash "$SCRIPT_DIR/execute.sh" --channel room-1 --notes-file "$TMP" --purpose 'Talk prep' </dev/null)"
unlink "$TMP"
assert_contains "missing --channel → error" "--channel is required" "$(bash "$SCRIPT_DIR/execute.sh" --lead Atlas 2>&1 </dev/null || true)"
assert_contains "missing notes file → error" "No file at" "$(bash "$SCRIPT_DIR/execute.sh" --channel room-1 --notes-file /nonexistent/x 2>&1 </dev/null || true)"
assert_contains "--help prints usage" "Usage:" "$(bash "$SCRIPT_DIR/execute.sh" --help </dev/null)"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
