#!/bin/bash
# =============================================================================
# Tests for poll-tasks skill
#
# Tests verify parameter validation, API call construction, and output format.
# Uses mock api_call to simulate backend responses without a running server.
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ERRORS=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${test_name}\n    expected: ${expected}\n    actual:   ${actual}"
    echo "  ✗ ${test_name}"
    echo "    expected: ${expected}"
    echo "    actual:   ${actual}"
  fi
}

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ ${test_name}"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${test_name}\n    expected to contain: ${needle}\n    actual: ${haystack}"
    echo "  ✗ ${test_name}"
    echo "    expected to contain: ${needle}"
    echo "    actual: ${haystack}"
  fi
}

assert_json_field() {
  local test_name="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(printf '%s' "$json" | jq -r "$field" 2>/dev/null || echo "PARSE_ERROR")
  assert_eq "$test_name" "$expected" "$actual"
}

# ---------------------------------------------------------------------------
# Test 1: Missing sessionName should fail
# ---------------------------------------------------------------------------
echo "Test 1: Missing sessionName should fail"
OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '{}' 2>&1) && EXIT_CODE=$? || EXIT_CODE=$?
assert_eq "exits with error code" "1" "$EXIT_CODE"
assert_contains "error mentions sessionName" "sessionName" "$OUTPUT"

# ---------------------------------------------------------------------------
# Test 2: Empty input should fail
# ---------------------------------------------------------------------------
echo "Test 2: Empty input should fail"
OUTPUT=$(bash "$SCRIPT_DIR/execute.sh" '' 2>&1) && EXIT_CODE=$? || EXIT_CODE=$?
assert_eq "exits with error code" "1" "$EXIT_CODE"

# ---------------------------------------------------------------------------
# Test 3: Role-based type defaults
# ---------------------------------------------------------------------------
echo "Test 3: Role-based type defaults"

source "$SCRIPT_DIR/types-for-role.sh"
get_types_for_role() { poll_types_for_role "$1"; }

assert_eq "developer types" "delegate,project_task,review" "$(get_types_for_role developer)"
assert_eq "researcher types" "delegate,check,review" "$(get_types_for_role researcher)"
assert_eq "analyst types" "delegate,check,review" "$(get_types_for_role analyst)"
assert_eq "team_lead types" "delegate,project_task,review,check" "$(get_types_for_role team_lead)"
assert_eq "team-lead types" "delegate,project_task,review,check" "$(get_types_for_role team-lead)"
assert_eq "unknown role types" "delegate,project_task" "$(get_types_for_role designer)"

# Every role that actually exists in config/roles must be classified here.
# A new role directory without an entry fails this test on purpose, so a role
# can never again silently fall to the default (team-leader did: TLs never
# received review items).
ROLES_DIR="$SCRIPT_DIR/../../../../roles"
CHECKED_ROLES=0
for d in "$ROLES_DIR"/*/; do
  r=$(basename "$d")
  CHECKED_ROLES=$((CHECKED_ROLES + 1))
  got=$(get_types_for_role "$r")
  case "$r" in
    team-leader|tpm|product-manager) want="delegate,project_task,review,check" ;;
    developer|backend-developer|frontend-developer|fullstack-dev|qa|qa-engineer|architect|auditor) want="delegate,project_task,review" ;;
    designer|generalist|ops|orchestrator|sales|support|content-strategist|researcher|ux-designer|_common) want="" ;;
    *) want="UNCLASSIFIED" ;;
  esac
  if [ "$want" = "UNCLASSIFIED" ]; then
    assert_eq "role '$r' is classified in the poll-tasks test" "classified" "UNCLASSIFIED"
  elif [ -n "$want" ]; then
    assert_eq "role '$r' default types" "$want" "$got"
  fi
done
assert_eq "role directories examined (>0)" "yes" "$([ "$CHECKED_ROLES" -gt 0 ] && echo yes || echo no)"
echo "  ($CHECKED_ROLES role dirs checked)"

# TLs must be able to see review items with no explicit types
assert_contains "team-leader gets review" "review" "$(get_types_for_role team-leader)"

# --- Refusal text: a fake server answers the targeted claim with slot_occupied ---
FAKE_PORT=$((20000 + RANDOM % 20000))
python3 - "$FAKE_PORT" >/dev/null 2>&1 <<'PY' &
import sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._send(200, {"success": True, "count": 1, "data": [{"id": "wi-queued", "title": "T", "description": ""}]})
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self._send(404, {"success": False, "error": "WorkItem wi-queued not claimable: tl already has WorkItem wi-running running",
                         "reason": "slot_occupied", "blockingWorkItemId": "wi-running"})
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
FAKE_PID=$!; disown
sleep 1
OUT=$(CREWLY_API_URL="http://127.0.0.1:$FAKE_PORT" CREWLY_SESSION_NAME=tl bash "$SCRIPT_DIR/execute.sh" '{"sessionName":"tl","role":"team-leader"}' 2>/dev/null | tail -n 40) || true
kill "$FAKE_PID" 2>/dev/null || true
assert_json_field "refusal carries reason" "$OUT" '.reason' "slot_occupied"
assert_json_field "refusal names the blocking item" "$OUT" '.blockingWorkItemId' "wi-running"
assert_contains "refusal text is the real reason" "already has WorkItem wi-running" "$OUT"
if printf '%s' "$OUT" | grep -q "claimed by another agent"; then
  assert_eq "no misleading 'claimed by another agent'" "absent" "present"
fi

# ---------------------------------------------------------------------------
# Test 4: Skill matching logic
# ---------------------------------------------------------------------------
echo "Test 4: Skill matching logic"

ITEMS='[
  {"id":"item-1","title":"Implement Python scraper","description":"Write a data scraper in Python","status":"queued"},
  {"id":"item-2","title":"Build React dashboard","description":"Create a TypeScript React component","status":"queued"},
  {"id":"item-3","title":"Write Rust parser","description":"Parser for log files in Rust","status":"queued"}
]'
SKILLS='["typescript","react"]'
PATTERN=$(printf '%s' "$SKILLS" | jq -r 'map(ascii_downcase) | join("|")')

# Should match item-2 (React/TypeScript)
MATCHED=$(printf '%s' "$ITEMS" | jq -c --arg pat "$PATTERN" '
  map(select(
    ((.title // "") | ascii_downcase | test($pat)) or
    ((.description // "") | ascii_downcase | test($pat))
  )) | first // null
')
MATCHED_ID=$(printf '%s' "$MATCHED" | jq -r '.id')
assert_eq "skill match finds React/TS item" "item-2" "$MATCHED_ID"

# No matching skills
SKILLS_NONE='["java","golang"]'
PATTERN_NONE=$(printf '%s' "$SKILLS_NONE" | jq -r 'map(ascii_downcase) | join("|")')
MATCHED_NONE=$(printf '%s' "$ITEMS" | jq -c --arg pat "$PATTERN_NONE" '
  map(select(
    ((.title // "") | ascii_downcase | test($pat)) or
    ((.description // "") | ascii_downcase | test($pat))
  )) | first // null
')
assert_eq "no skill match returns null" "null" "$MATCHED_NONE"

# Match by description only (TypeScript is in description of item-2)
SKILLS_DESC='["typescript"]'
PATTERN_DESC=$(printf '%s' "$SKILLS_DESC" | jq -r 'map(ascii_downcase) | join("|")')
MATCHED_DESC=$(printf '%s' "$ITEMS" | jq -c --arg pat "$PATTERN_DESC" '
  map(select(
    ((.title // "") | ascii_downcase | test($pat)) or
    ((.description // "") | ascii_downcase | test($pat))
  )) | first // null
')
MATCHED_DESC_ID=$(printf '%s' "$MATCHED_DESC" | jq -r '.id')
assert_eq "skill match by description" "item-2" "$MATCHED_DESC_ID"

# ---------------------------------------------------------------------------
# Test 5: Output format for no-work scenario
# ---------------------------------------------------------------------------
echo "Test 5: Output format validation"

# Simulate no-work output
NO_WORK_OUTPUT=$(jq -n '{success: true, claimed: false, available: 0, message: "No available work items matching agent capabilities"}')
assert_json_field "success is true" "$NO_WORK_OUTPUT" ".success" "true"
assert_json_field "claimed is false" "$NO_WORK_OUTPUT" ".claimed" "false"
assert_json_field "available is 0" "$NO_WORK_OUTPUT" ".available" "0"
assert_contains "message present" "No available" "$NO_WORK_OUTPUT"

# Simulate claimed output
CLAIMED_OUTPUT=$(jq -n '
  {
    success: true,
    claimed: true,
    workItemId: "wi-123",
    claimId: "cl-456",
    workItem: {id: "wi-123", title: "Test task", type: "delegate"},
    claim: {id: "cl-456", agentId: "test-agent"}
  }')
assert_json_field "claim success" "$CLAIMED_OUTPUT" ".success" "true"
assert_json_field "claim claimed" "$CLAIMED_OUTPUT" ".claimed" "true"
assert_json_field "workItemId" "$CLAIMED_OUTPUT" ".workItemId" "wi-123"
assert_json_field "claimId" "$CLAIMED_OUTPUT" ".claimId" "cl-456"
assert_json_field "workItem.title" "$CLAIMED_OUTPUT" ".workItem.title" "Test task"
assert_json_field "workItem.type" "$CLAIMED_OUTPUT" ".workItem.type" "delegate"
assert_json_field "claim.agentId" "$CLAIMED_OUTPUT" ".claim.agentId" "test-agent"

# ---------------------------------------------------------------------------
# Test 6: Custom types parameter overrides role defaults
# ---------------------------------------------------------------------------
echo "Test 6: Custom types override"

# When types is explicitly set, role default should NOT apply
TYPES_EXPLICIT="check,notify"
ROLE="developer"
if [ -n "$TYPES_EXPLICIT" ]; then
  FINAL_TYPES="$TYPES_EXPLICIT"
else
  FINAL_TYPES="$(get_types_for_role "$ROLE")"
fi
assert_eq "explicit types override role default" "check,notify" "$FINAL_TYPES"

# When types is empty, role default applies
TYPES_EMPTY=""
ROLE="developer"
if [ -n "$TYPES_EMPTY" ]; then
  FINAL_TYPES2="$TYPES_EMPTY"
else
  FINAL_TYPES2="$(get_types_for_role "$ROLE")"
fi
assert_eq "empty types uses role default" "delegate,project_task,review" "$FINAL_TYPES2"

# ---------------------------------------------------------------------------
# Test 7: D8 fallback — target= query when owner=agent yields zero
#
# Mirrors the production logic: when the primary owner=agent response has
# count=0, we should adopt the target= response if it contains any items,
# and record the first item's id as TARGET_PINNED_ID so the claim step
# can claim by workItemId rather than by FIFO filters.
# ---------------------------------------------------------------------------
echo "Test 7: D8 fallback for orchestrator-owned target items"

OWNER_AGENT_EMPTY='{"success":true,"data":[],"count":0}'
TARGET_RESPONSE_HIT='{"success":true,"data":[
  {"id":"wi-orc-1","type":"delegate","owner":"orchestrator","target":"agent-1","status":"queued"},
  {"id":"wi-orc-2","type":"delegate","owner":"orchestrator","target":"agent-1","status":"queued"}
],"count":2}'

# Simulate the merge step
AVAILABLE_RESPONSE_SIM="$OWNER_AGENT_EMPTY"
AVAILABLE_COUNT_SIM=$(printf '%s' "$AVAILABLE_RESPONSE_SIM" | jq -r '.count // 0')
TARGET_PINNED_ID_SIM=""
if [ "$AVAILABLE_COUNT_SIM" -eq 0 ]; then
  TARGET_RESPONSE_SIM="$TARGET_RESPONSE_HIT"
  TARGET_COUNT_SIM=$(printf '%s' "$TARGET_RESPONSE_SIM" | jq -r '.count // 0')
  if [ "$TARGET_COUNT_SIM" -gt 0 ]; then
    AVAILABLE_RESPONSE_SIM="$TARGET_RESPONSE_SIM"
    AVAILABLE_COUNT_SIM="$TARGET_COUNT_SIM"
    TARGET_PINNED_ID_SIM=$(printf '%s' "$TARGET_RESPONSE_SIM" | jq -r '(.data // [])[0].id // empty')
  fi
fi

assert_eq "fallback adopts target response count" "2" "$AVAILABLE_COUNT_SIM"
assert_eq "fallback pins first target item id" "wi-orc-1" "$TARGET_PINNED_ID_SIM"

# When BOTH queries are empty, AVAILABLE_COUNT stays 0 and no pin is set
AVAILABLE_RESPONSE_EMPTY="$OWNER_AGENT_EMPTY"
AVAILABLE_COUNT_EMPTY=$(printf '%s' "$AVAILABLE_RESPONSE_EMPTY" | jq -r '.count // 0')
TARGET_PINNED_ID_EMPTY=""
if [ "$AVAILABLE_COUNT_EMPTY" -eq 0 ]; then
  TARGET_RESPONSE_EMPTY='{"success":true,"data":[],"count":0}'
  TARGET_COUNT_EMPTY=$(printf '%s' "$TARGET_RESPONSE_EMPTY" | jq -r '.count // 0')
  if [ "$TARGET_COUNT_EMPTY" -gt 0 ]; then
    AVAILABLE_RESPONSE_EMPTY="$TARGET_RESPONSE_EMPTY"
    AVAILABLE_COUNT_EMPTY="$TARGET_COUNT_EMPTY"
    TARGET_PINNED_ID_EMPTY=$(printf '%s' "$TARGET_RESPONSE_EMPTY" | jq -r '(.data // [])[0].id // empty')
  fi
fi
assert_eq "both-empty leaves count at 0" "0" "$AVAILABLE_COUNT_EMPTY"
assert_eq "both-empty leaves pin empty" "" "$TARGET_PINNED_ID_EMPTY"

# When owner=agent has items already, fallback must NOT fire
OWNER_AGENT_HIT='{"success":true,"data":[
  {"id":"wi-agent-1","type":"project_task","owner":"agent","status":"queued"}
],"count":1}'
AVAILABLE_RESPONSE_PRI="$OWNER_AGENT_HIT"
AVAILABLE_COUNT_PRI=$(printf '%s' "$AVAILABLE_RESPONSE_PRI" | jq -r '.count // 0')
TARGET_PINNED_ID_PRI=""
if [ "$AVAILABLE_COUNT_PRI" -eq 0 ]; then
  TARGET_PINNED_ID_PRI="should-not-be-set"
fi
assert_eq "primary-hit keeps count=1" "1" "$AVAILABLE_COUNT_PRI"
assert_eq "primary-hit leaves pin empty (no fallback)" "" "$TARGET_PINNED_ID_PRI"

# ---------------------------------------------------------------------------
# Test 8: Claim body shape — workItemId vs filters
#
# When TARGET_PINNED_ID is set, the claim body must include workItemId.
# Otherwise it uses the FIFO filters shape. Both are accepted by the
# /task-pool/claim endpoint, but only the workItemId form will claim
# orchestrator-owned items.
# ---------------------------------------------------------------------------
echo "Test 8: Claim body shape"

build_claim_body() {
  local pinned="$1" session="$2" types="$3"
  if [ -n "$pinned" ]; then
    jq -nc \
      --arg agentId "$session" \
      --arg workItemId "$pinned" \
      '{agentId: $agentId, workItemId: $workItemId}'
  else
    jq -nc \
      --arg agentId "$session" \
      --arg types "$types" \
      '{agentId: $agentId, filters: {types: ($types | split(","))}}'
  fi
}

PINNED_BODY=$(build_claim_body "wi-orc-1" "agent-1" "delegate,project_task")
assert_json_field "pinned body has workItemId" "$PINNED_BODY" ".workItemId" "wi-orc-1"
assert_json_field "pinned body has agentId" "$PINNED_BODY" ".agentId" "agent-1"
assert_json_field "pinned body has no filters" "$PINNED_BODY" ".filters" "null"

FIFO_BODY=$(build_claim_body "" "agent-1" "delegate,project_task")
assert_json_field "fifo body has agentId" "$FIFO_BODY" ".agentId" "agent-1"
assert_json_field "fifo body has no workItemId" "$FIFO_BODY" ".workItemId" "null"
assert_json_field "fifo body types[0]" "$FIFO_BODY" ".filters.types[0]" "delegate"
assert_json_field "fifo body types[1]" "$FIFO_BODY" ".filters.types[1]" "project_task"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "======================================="
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "======================================="

if [ $FAIL -gt 0 ]; then
  echo -e "\nFailures:${ERRORS}"
  exit 1
fi

exit 0
