#!/bin/bash
# =============================================================================
# Tests for complete-task skill
#
# Guards how this skill resolves WHICH WorkItem to complete.
#
# `absoluteTaskPath` used to be `require_param`'d, which contradicted the
# skill's own resolution logic: the V3 path selects the WorkItem from
# `workItemId` (or a pool lookup) and treats `absoluteTaskPath` as legacy
# logging context only. Passing `workItemId` alone therefore returned
# `{"error":"Missing required parameter: absoluteTaskPath"}` and agents had
# to bypass the skill and curl /api/task-pool/complete by hand.
#
# These tests fail if that requirement is reintroduced, if the legacy
# `absoluteTaskPath` path stops working, or if resolving nothing degrades
# into a silent no-op instead of a clear error.
#
# `curl` is stubbed on PATH, so every case runs offline and deterministically
# while still proving the real HTTP request the skill would have issued.
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ERRORS=""

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${test_name}\n    expected to contain: ${needle}\n    actual: ${haystack}"
    echo "  ✗ ${test_name}"
    echo "    expected to contain: ${needle}"
  fi
}

assert_not_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${test_name}\n    expected NOT to contain: ${needle}\n    actual: ${haystack}"
    echo "  ✗ ${test_name}"
    echo "    expected NOT to contain: ${needle}"
  else
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  fi
}

# ---------------------------------------------------------------------------
# curl stub
#
# api_call() shells out to bare `curl`, so shadowing it on PATH intercepts
# every request without touching the skill. The stub records `METHOD URL` and
# the request body, then emits `<body>\n<http_code>` — the exact shape
# api_call parses because of its `-w '\n%{http_code}'`.
#
# GET /task-pool/items returns one WorkItem so the legacy pool-lookup path
# resolves, or an empty list when STUB_POOL_EMPTY=1, which is how the
# "resolves nothing" case is exercised.
# ---------------------------------------------------------------------------
STUB_DIR="$(mktemp -d)"
cat > "$STUB_DIR/curl" << 'STUB_EOF'
#!/bin/bash
METHOD="GET"; BODY=""; URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) METHOD="$2"; shift 2 ;;
    -d) BODY="$2";   shift 2 ;;
    -H) shift 2 ;;
    -w) shift 2 ;;
    -s) shift ;;
    *)  URL="$1";    shift ;;
  esac
done
echo "${METHOD} ${URL}" >> "$CURL_LOG"
# Flatten to one line per request: jq -n pretty-prints, and the assertions
# below need one parseable JSON document per log line.
printf '%s\n' "$(printf '%s' "$BODY" | tr '\n' ' ')" >> "$CURL_BODY_LOG"

if [ "$METHOD" = "GET" ] && printf '%s' "$URL" | grep -q '/task-pool/items'; then
  if [ "${STUB_POOL_EMPTY:-0}" = "1" ]; then
    echo '{"success":true,"data":[],"count":0}'
  else
    echo '{"success":true,"data":[{"id":"wi-from-pool"}],"count":1}'
  fi
  echo "200"
  exit 0
fi

echo '{"success":true,"stub":true}'
echo "200"
STUB_EOF
chmod +x "$STUB_DIR/curl"

export CREWLY_API_URL="http://stub.invalid"
export PATH="$STUB_DIR:$PATH"

# Runs execute.sh with a fresh request log. Sets OUT (stdout+stderr),
# REQUESTS (one "METHOD URL" per line) and BODIES (request bodies).
run_skill() {
  CURL_LOG="$(mktemp)"; export CURL_LOG
  CURL_BODY_LOG="$(mktemp)"; export CURL_BODY_LOG
  OUT="$(bash "$SCRIPT_DIR/execute.sh" "$1" 2>&1)" || true
  REQUESTS="$(cat "$CURL_LOG")"
  BODIES="$(cat "$CURL_BODY_LOG")"
  rm -f "$CURL_LOG" "$CURL_BODY_LOG"
}

echo "=== complete-task tests ==="

echo ""
echo "--- workItemId alone is sufficient (the reported bug) ---"

run_skill '{"workItemId":"wi-explicit","sessionName":"dev-1","summary":"Implemented feature X"}'
assert_not_contains "workItemId alone does NOT demand absoluteTaskPath" \
  "Missing required parameter: absoluteTaskPath" "$OUT"
assert_contains "workItemId alone reaches POST /task-pool/complete/<id>" \
  "POST http://stub.invalid/api/task-pool/complete/wi-explicit" "$REQUESTS"
assert_not_contains "workItemId alone skips the pool lookup entirely" \
  "/task-pool/items" "$REQUESTS"

echo ""
echo "--- Canonical completion body ---"

# The endpoint reads `result.summary`; a top-level `summary` is ignored and
# 400s (task-pool.controller.ts `completeItem`).
# Tolerate no-match so a regression elsewhere reports as a failed assertion
# rather than killing the run under `set -e` / `pipefail`.
COMPLETE_BODY="$(printf '%s' "$BODIES" | grep 'agentId' | head -1 || true)"
assert_contains "body carries agentId" '"agentId": "dev-1"' "$COMPLETE_BODY"
assert_contains "body nests summary under result" '"summary": "Implemented feature X"' "$COMPLETE_BODY"
RESULT_SUMMARY="$(printf '%s' "$COMPLETE_BODY" | jq -r '.result.summary // "MISSING"' 2>/dev/null || echo "MISSING")"
assert_contains "result.summary is populated" "Implemented feature X" "$RESULT_SUMMARY"

echo ""
echo "--- Legacy absoluteTaskPath callers keep working (no regression) ---"

run_skill '{"absoluteTaskPath":"/proj/.crewly/tasks/in_progress/t.md","sessionName":"dev-2","summary":"Legacy caller"}'
assert_contains "legacy-only call falls back to the pool lookup" \
  "GET http://stub.invalid/api/task-pool/items" "$REQUESTS"
assert_contains "legacy-only call completes the resolved WorkItem" \
  "POST http://stub.invalid/api/task-pool/complete/wi-from-pool" "$REQUESTS"

run_skill '{"absoluteTaskPath":"/proj/.crewly/tasks/in_progress/t.md","workItemId":"wi-both","sessionName":"dev-2","summary":"Both identifiers"}'
assert_contains "explicit workItemId wins when both are supplied" \
  "POST http://stub.invalid/api/task-pool/complete/wi-both" "$REQUESTS"

echo ""
echo "--- Neither identifier resolves: clear error, not a silent no-op ---"

STUB_POOL_EMPTY=1 run_skill '{"sessionName":"dev-3","summary":"Nothing to complete"}'
assert_contains "unresolvable completion reports an error" '"error"' "$OUT"
assert_contains "error names the workItemId parameter to pass" "workItemId" "$OUT"
assert_contains "error names the session it searched" "dev-3" "$OUT"
assert_not_contains "unresolvable completion does NOT POST a completion" \
  "/task-pool/complete/" "$REQUESTS"

CURL_LOG="$(mktemp)"; export CURL_LOG
CURL_BODY_LOG="$(mktemp)"; export CURL_BODY_LOG
if STUB_POOL_EMPTY=1 bash "$SCRIPT_DIR/execute.sh" \
     '{"sessionName":"dev-3","summary":"Nothing to complete"}' > /dev/null 2>&1; then
  FAIL=$((FAIL + 1))
  echo "  ✗ unresolvable completion exits non-zero"
  ERRORS="${ERRORS}\n  ✗ unresolvable completion exits non-zero (exited 0)"
else
  PASS=$((PASS + 1))
  echo "  ✓ unresolvable completion exits non-zero"
fi
rm -f "$CURL_LOG" "$CURL_BODY_LOG"

echo ""
echo "--- Remaining required parameters still enforced ---"

run_skill '{"workItemId":"wi-1","summary":"no session"}'
assert_contains "Missing sessionName returns error" "sessionName" "$OUT"

run_skill '{"workItemId":"wi-1","sessionName":"dev-1"}'
assert_contains "Missing summary returns error" "summary" "$OUT"

OUT="$(bash "$SCRIPT_DIR/execute.sh" '' 2>&1)" || true
assert_contains "Empty input returns usage error" "Usage" "$OUT"
assert_contains "Usage example leads with workItemId" "workItemId" "$OUT"

echo ""
echo "--- Source-level guards ---"

SRC="$(cat "$SCRIPT_DIR/execute.sh")"

assert_not_contains "absoluteTaskPath is NOT a required parameter" \
  'require_param "absoluteTaskPath"' "$SRC"
assert_contains "absoluteTaskPath is still parsed (legacy callers accepted)" \
  "jq -r '.absoluteTaskPath // empty'" "$SRC"
assert_contains "sessionName is still required" 'require_param "sessionName"' "$SRC"
assert_contains "summary is still required" 'require_param "summary"' "$SRC"
assert_contains "unresolved WorkItem exits via error_exit" \
  'error_exit "Could not resolve a WorkItem to complete' "$SRC"
assert_contains "legacy in_progress shortcut only runs on the legacy path" \
  'if [ -n "$ABSOLUTE_TASK_PATH" ] && echo "$ABSOLUTE_TASK_PATH" | grep -q' "$SRC"

# Cleanup
rm -rf "$STUB_DIR"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if [ $FAIL -gt 0 ]; then
  echo -e "\nFailures:${ERRORS}"
  exit 1
fi
