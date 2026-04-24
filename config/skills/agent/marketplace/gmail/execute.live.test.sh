#!/bin/bash
#
# Happy-path tests for the gmail multi-action skill.
#
# Why this file exists (in addition to execute.test.sh):
#
# `execute.test.sh` covers input/usage error paths only — every API-touching
# test there uses a fake token and asserts only `exit != 0`. That is NOT
# sufficient to catch bugs in the success path. The v1.1.0 ship had a
# subshell-scope bug in the HTTP status capture that mis-classified every
# successful 200 as a failure; the 52-test suite passed anyway because the
# fake token genuinely caused a 401 from Google, which yielded the same
# non-zero exit code (for a different reason). False green.
#
# This file boots a local Python mock server that mirrors the Gmail API
# routes the skill calls, points the skill at it via the GMAIL_API_BASE env
# var, and asserts on the actual JSON output of every action — including a
# 401 negative path that confirms the error branch fires for the *real*
# reason and not an artifact of broken parsing.
#
# Requirements: python3 (stdlib only — http.server / json / threading).
#
# Run from anywhere:
#     bash config/skills/agent/marketplace/gmail/execute.live.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE="$SCRIPT_DIR/execute.sh"
MOCK_PY="$SCRIPT_DIR/mock-gmail-server.py"

PASS=0
FAIL=0
MOCK_PID=""
MOCK_PORT=""

cleanup() {
  if [ -n "$MOCK_PID" ]; then
    kill -TERM "$MOCK_PID" 2>/dev/null || true
    sleep 0.2
    kill -9 "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_mock() {
  local mode="${1:-pass}"
  local port_file
  port_file=$(mktemp)

  # Boot mock and read the LISTENING line for its bound port.
  python3 "$MOCK_PY" --port 0 --token-mode "$mode" >"$port_file" 2>/dev/null &
  MOCK_PID=$!

  # Wait up to 5s for the LISTENING line.
  local i=0
  while [ "$i" -lt 50 ]; do
    if grep -q "^LISTENING " "$port_file" 2>/dev/null; then
      break
    fi
    sleep 0.1
    i=$((i + 1))
  done

  if ! grep -q "^LISTENING " "$port_file" 2>/dev/null; then
    echo "FAIL: mock server did not announce LISTENING within 5s"
    rm -f "$port_file"
    return 1
  fi

  MOCK_PORT=$(awk '/^LISTENING / {print $2; exit}' "$port_file")
  rm -f "$port_file"
  return 0
}

stop_mock() {
  if [ -n "$MOCK_PID" ]; then
    # SIGTERM first; if that doesn't kill it within a short grace period the
    # SIGKILL falls back. We bypass `wait` because Python's http.server can
    # block on its own thread shutdown longer than the test wants to wait.
    kill -TERM "$MOCK_PID" 2>/dev/null || true
    local i=0
    while kill -0 "$MOCK_PID" 2>/dev/null; do
      [ "$i" -ge 10 ] && break
      sleep 0.1
      i=$((i + 1))
    done
    if kill -0 "$MOCK_PID" 2>/dev/null; then
      kill -9 "$MOCK_PID" 2>/dev/null || true
    fi
  fi
  MOCK_PID=""
}

# call INPUT_JSON OUT_BODY_VAR OUT_EXIT_VAR
#
# Invoke the skill with the given JSON input against the running mock,
# writing the skill's stdout into the caller-named OUT_BODY_VAR and its
# exit code into OUT_EXIT_VAR. MUST be called directly (no `$(...)`) so the
# `printf -v` writes into the caller's shell scope. (The same lesson the
# v1.1.0 fix taught us — see execute.sh's gmail_call docstring.)
call() {
  local input="$1" out_var="$2" exit_var="$3"
  local out
  out=$(GMAIL_API_BASE="http://127.0.0.1:${MOCK_PORT}/gmail/v1/users/me" \
    CREWLY_CRED_GMAIL_ACCESS_TOKEN="ya29.mock-token-for-tests" \
    CREWLY_CRED_GMAIL_EMAIL="test@example.com" \
    bash "$EXECUTE" "$input" 2>/dev/null)
  local code=$?
  printf -v "$out_var" '%s' "$out"
  printf -v "$exit_var" '%s' "$code"
}

assert() {
  local desc="$1" cond="$2"
  if [ "$cond" = "1" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

# jget JSON JQ_FILTER  -> echoes value or empty
jget() {
  printf '%s' "$1" | jq -r "$2" 2>/dev/null
}

echo "=== gmail skill happy-path tests (against local mock server) ==="

# --- Boot the mock in pass-through mode ------------------------------------
if ! start_mock pass; then
  echo "FATAL: could not start mock server — aborting"
  exit 1
fi
echo "Mock listening on 127.0.0.1:${MOCK_PORT}"

# --- 1. list ---------------------------------------------------------------
echo ""
echo "Test 1: list returns success:true with messages array"
call '{"action":"list","q":"is:unread in:inbox","maxResults":3}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "success:true" "$([ "$(jget "$OUT" '.success')" = "true" ] && echo 1)"
assert "count >= 1" "$([ "$(jget "$OUT" '.count')" -ge 1 ] && echo 1)"
assert "first message id matches mock" \
  "$([ "$(jget "$OUT" '.messages[0].id')" = "MSG_TEST_001" ] && echo 1)"
assert "first message subject populated" \
  "$([ -n "$(jget "$OUT" '.messages[0].subject')" ] && echo 1)"

# --- 2. search (alias of list) ---------------------------------------------
echo ""
echo "Test 2: search returns success:true (same shape as list)"
call '{"action":"search","q":"subject:mock","maxResults":2}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "success:true" "$([ "$(jget "$OUT" '.success')" = "true" ] && echo 1)"
assert "echo of query in payload" "$([ "$(jget "$OUT" '.query')" = "subject:mock" ] && echo 1)"

# --- 3. read ---------------------------------------------------------------
echo ""
echo "Test 3: read returns success:true with decoded body"
call '{"action":"read","id":"MSG_TEST_001"}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "success:true" "$([ "$(jget "$OUT" '.success')" = "true" ] && echo 1)"
assert "id matches" "$([ "$(jget "$OUT" '.id')" = "MSG_TEST_001" ] && echo 1)"
assert "subject in headers" \
  "$([ -n "$(jget "$OUT" '.headers.subject')" ] && echo 1)"
assert "body decoded from base64url" \
  "$(echo "$(jget "$OUT" '.body')" | grep -q 'Hello from the mock server' && echo 1)"
assert "labelIds present" \
  "$([ "$(jget "$OUT" '.labelIds | length')" -ge 1 ] && echo 1)"

# --- 4. list-labels --------------------------------------------------------
echo ""
echo "Test 4: list-labels returns success:true with system + user labels"
call '{"action":"list-labels"}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "success:true" "$([ "$(jget "$OUT" '.success')" = "true" ] && echo 1)"
assert "count == 6" "$([ "$(jget "$OUT" '.count')" = "6" ] && echo 1)"
assert "INBOX present" \
  "$(echo "$OUT" | jq -e '.labels | map(.id) | index("INBOX")' >/dev/null && echo 1)"
assert "Label_5 (user) present" \
  "$(echo "$OUT" | jq -e '.labels | map(.id) | index("Label_5")' >/dev/null && echo 1)"

# --- 5. mark-as-read (UNREAD removed) --------------------------------------
echo ""
echo "Test 5: mark-as-read removes UNREAD"
call '{"action":"mark-as-read","id":"MSG_TEST_001"}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "success:true" "$([ "$(jget "$OUT" '.success')" = "true" ] && echo 1)"
assert "UNREAD no longer in labelIds" \
  "$(echo "$OUT" | jq -e '.labelIds | index("UNREAD") | not' >/dev/null && echo 1)"
assert "INBOX still in labelIds" \
  "$(echo "$OUT" | jq -e '.labelIds | index("INBOX")' >/dev/null && echo 1)"

# --- 6. mark-as-unread (UNREAD added back) ---------------------------------
echo ""
echo "Test 6: mark-as-unread restores UNREAD"
call '{"action":"mark-as-unread","id":"MSG_TEST_001"}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "UNREAD back in labelIds" \
  "$(echo "$OUT" | jq -e '.labelIds | index("UNREAD")' >/dev/null && echo 1)"

# --- 7. add-label (single string form) -------------------------------------
echo ""
echo "Test 7: add-label (labelId string) adds STARRED"
call '{"action":"add-label","id":"MSG_TEST_001","labelId":"STARRED"}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "STARRED added" \
  "$(echo "$OUT" | jq -e '.labelIds | index("STARRED")' >/dev/null && echo 1)"

# --- 8. remove-label (array form) ------------------------------------------
echo ""
echo "Test 8: remove-label (labelIds array) removes STARRED"
call '{"action":"remove-label","id":"MSG_TEST_001","labelIds":["STARRED"]}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "STARRED removed" \
  "$(echo "$OUT" | jq -e '.labelIds | index("STARRED") | not' >/dev/null && echo 1)"

# --- 9. send ---------------------------------------------------------------
echo ""
echo "Test 9: send returns success:true with id"
call '{"action":"send","to":"a@b.com","subject":"Mock test","body":"Hello world"}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "success:true" "$([ "$(jget "$OUT" '.success')" = "true" ] && echo 1)"
assert "returned id matches mock" "$([ "$(jget "$OUT" '.id')" = "MOCK_SENT_001" ] && echo 1)"
assert "returned threadId" "$([ "$(jget "$OUT" '.threadId')" = "THREAD_SENT_001" ] && echo 1)"

# --- 10. send (cc + bcc) ---------------------------------------------------
echo ""
echo "Test 10: send with cc+bcc still succeeds"
call '{"action":"send","to":"a@b.com","subject":"cc test","body":"hi","cc":"c@b.com","bcc":"d@b.com"}' OUT EXIT
assert "exit=0" "$([ "$EXIT" = "0" ] && echo 1)"
assert "success:true" "$([ "$(jget "$OUT" '.success')" = "true" ] && echo 1)"

# --- Switch to 401 mode, confirm error path is exercised for the RIGHT reason
stop_mock
echo ""
echo "Test 11: 401-mode mock — error branch fires with HTTP 401 (not '?')"
if ! start_mock 401; then
  echo "FATAL: could not start 401-mode mock"
  exit 1
fi
echo "Mock listening on 127.0.0.1:${MOCK_PORT} in 401-mode"

call '{"action":"list-labels"}' OUT EXIT
assert "exit=2 (api error)" "$([ "$EXIT" = "2" ] && echo 1)"
assert "success:false" "$([ "$(jget "$OUT" '.success')" = "false" ] && echo 1)"
# The crucial assertion that would have caught the v1.1.0 bug: the error
# message must surface the REAL HTTP status (401), not the "?" placeholder
# that came from a missing _LAST_HTTP propagation.
assert "error message contains 'HTTP 401' (real status, not '?')" \
  "$(echo "$OUT" | jq -r '.error' | grep -q 'HTTP 401' && echo 1)"
assert "error message does NOT contain 'HTTP ?' placeholder" \
  "$(echo "$OUT" | jq -r '.error' | grep -qv 'HTTP ?' && echo 1)"

# --- Same for send (POST path uses the same gmail_call) --------------------
echo ""
echo "Test 12: 401-mode mock — send surfaces real 401, not '?'"
call '{"action":"send","to":"a@b.com","subject":"x","body":"y"}' OUT EXIT
assert "exit=2" "$([ "$EXIT" = "2" ] && echo 1)"
assert "error contains HTTP 401" \
  "$(echo "$OUT" | jq -r '.error' | grep -q 'HTTP 401' && echo 1)"

# --- 500 mode — confirm parser handles 5xx the same way --------------------
stop_mock
echo ""
echo "Test 13: 500-mode mock — error branch surfaces 500"
if ! start_mock 500; then
  echo "FATAL: could not start 500-mode mock"
  exit 1
fi
call '{"action":"list-labels"}' OUT EXIT
assert "exit=2" "$([ "$EXIT" = "2" ] && echo 1)"
assert "error contains HTTP 500" \
  "$(echo "$OUT" | jq -r '.error' | grep -q 'HTTP 500' && echo 1)"

stop_mock

# --- Summary ---------------------------------------------------------------
echo ""
echo "Summary: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
