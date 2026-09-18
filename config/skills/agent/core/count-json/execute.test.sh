#!/bin/bash
# Tests for count-json — run with: bash execute.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
run() { bash "$EXEC" "$1" 2>/dev/null; }
run_err() { bash "$EXEC" "$1" 2>&1 >/dev/null | jq -r '.error' 2>/dev/null; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf '%s' '[{"ticketId":"T1","status":"open"},{"ticketId":"T2","status":"review"},{"ticketId":"T3","status":"review"},{"ticketId":"T4","status":"blocked"}]' > "$TMP/board.json"
printf '%s' 'fetching...
{"items":[{"s":"a"},{"s":"b"}]}' > "$TMP/nested.txt"

ARGS=$(jq -cn --arg f "$TMP/board.json" '{file:$f, field:"status", value:"review"}')
check "filter by field=value" "$(run "$ARGS")" '{"count":2,"total":4,"filter":"status=review"}'

ARGS=$(jq -cn --arg f "$TMP/board.json" '{file:$f}')
check "no filter counts all" "$(run "$ARGS")" '{"count":4,"total":4,"filter":""}'

ARGS=$(jq -cn --arg c "cat $TMP/nested.txt" '{command:$c, field:"s", value:"b"}')
check "command with preamble and nested items" "$(run "$ARGS")" '{"count":1,"total":2,"filter":"s=b"}'

ARGS=$(jq -cn --arg f "$TMP/board.json" '{file:$f, arrayPath:".", field:"status", value:"open"}')
check "explicit arrayPath" "$(run "$ARGS")" '{"count":1,"total":4,"filter":"status=open"}'

check "non-JSON errors" "$(run_err '{"command":"echo not json"}')" "no JSON found in output"
check "missing input errors" "$(run_err '{}')" "command or file is required"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
