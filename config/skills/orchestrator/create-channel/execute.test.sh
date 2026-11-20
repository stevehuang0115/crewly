#!/bin/bash
# Tests for create-channel: argument parsing and request body.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
assert_eq() { if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2', got '$3'"; FAIL=$((FAIL+1)); fi; }
assert_contains() { if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi; }

export CREWLY_SKILL_DRY_RUN=1
assert_eq "new channel body" \
  'POST /channels/compose {"name":"ce-growth","members":["Owen","王律师增长团队 Lead"]}' \
  "$(bash "$SCRIPT_DIR/execute.sh" --name ce-growth --members "Owen, 王律师增长团队 Lead")"
assert_eq "purpose is included" \
  'POST /channels/compose {"name":"x","members":["A"],"purpose":"why"}' \
  "$(bash "$SCRIPT_DIR/execute.sh" --name x --members A --purpose why)"
assert_eq "--add targets an existing channel" \
  'POST /channels/compose {"channel":"ce-growth","members":["Owen","Mia"]}' \
  "$(bash "$SCRIPT_DIR/execute.sh" --add ce-growth --members "Owen;Mia")"
assert_eq "empty entries dropped" \
  'POST /channels/compose {"name":"x","members":["A","B"]}' \
  "$(bash "$SCRIPT_DIR/execute.sh" --name x --members ",A,, B ,")"
assert_contains "--help prints usage" "Usage:" "$(bash "$SCRIPT_DIR/execute.sh" --help)"
out=$(bash "$SCRIPT_DIR/execute.sh" --name x 2>&1 || true)
assert_contains "missing members is an error" "required" "$out"
out=$(bash "$SCRIPT_DIR/execute.sh" --members A 2>&1 || true)
assert_contains "missing name/add is an error" "required" "$out"

# Formatter: a canned backend response goes through the real jq program.
unset CREWLY_SKILL_DRY_RUN
fmt() { CREWLY_SKILL_FAKE_RESPONSE="$1" bash "$SCRIPT_DIR/execute.sh" --name x --members A 2>&1 || true; }
ok='{"success":true,"data":{"channel":{"name":"iris","created":true,"slackChannelId":"C1"},"added":[{"name":"Mei","team":"Iris","machine":"mini"}],"requested":[{"name":"Ning","machine":"mac"}],"failed":[{"name":"Bo","reason":"offline"}],"ambiguous":[{"term":"Sam","candidates":["Sam A","Sam B"]}],"notFound":["Zed"]}}'
out=$(fmt "$ok")
assert_contains "created header" "Channel #iris created (Slack C1)" "$out"
assert_contains "added line" "ADDED: Mei (Iris, mini)" "$out"
assert_contains "requested line" "ASKED (joins on its own machine shortly): Ning (mac)" "$out"
assert_contains "failed line" "FAILED: Bo — offline" "$out"
assert_contains "ambiguous line" "AMBIGUOUS: Sam — could be: Sam A; Sam B" "$out"
assert_contains "not found line" "NOT FOUND: Zed" "$out"
assert_contains "owner note" "Tell the owner plainly" "$out"
case "$out" in *"jq: error"*) echo "FAIL: jq error in output: $out"; FAIL=$((FAIL+1));; *) echo "PASS: no jq error"; PASS=$((PASS+1));; esac
out=$(fmt '{"success":true,"data":{"channel":{"name":"iris","created":false},"added":[],"requested":[],"failed":[],"ambiguous":[],"notFound":[]}}')
assert_eq "updated, Crewly-only, nothing else" "Channel #iris updated (Crewly-only, Slack is not connected)" "$out"
assert_eq "error response" "ERROR: only the orchestrator may do this (only the orchestrator and the owner may do this)" \
  "$(fmt '{"success":false,"error":"owner_only","message":"only the orchestrator may do this"}')"
assert_eq "error without message" "ERROR: boom" "$(fmt '{"success":false,"error":"boom"}')"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
