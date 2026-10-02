#!/bin/bash
# Tests for TL verify-output execute.sh
# Covers: passPolicy resolution — an approved checklist's passPolicy must
#         survive into the verdict (it used to be clobbered by the
#         pipeline-loading defaults), a template pipeline still overrides
#         it when no checklist checks were loaded, and the default is "all".
#
# The real execute.sh is run end-to-end; HTTP is intercepted by a fake `curl`
# placed first on PATH so api_call() sees controlled responses.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# ---------------------------------------------------------------------------
# Fake curl: dispatches on the URL (last argument) and emits body + http code
# in the `-w '\n%{http_code}'` shape api_call() parses.
# ---------------------------------------------------------------------------
FAKE_BIN="$WORK_DIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/curl" <<'CURL_EOF'
#!/bin/bash
url="${@: -1}"
case "$url" in
  */api/task-pool/items/wi-ev)
    printf '%s\n200' '{"success":true,"data":{"id":"wi-ev","status":"done_by_worker","output":{"summary":"Report written","evidence":[{"type":"artifact","path":"/proj/report.md"},{"type":"command","command":"npm test","exitCode":0}]}}}'
    ;;
  */api/task-pool/items/wi-noev)
    printf '%s\n200' '{"success":true,"data":{"id":"wi-noev","status":"done_by_worker","output":{"summary":"Trust me"}}}'
    ;;
  */api/task-pool/items/wi-blocked)
    printf '%s\n200' '{"success":true,"data":{"id":"wi-blocked","status":"blocked","output":{"summary":"Stuck","evidence":[{"type":"blocked","step":"deploy","reason":"no creds"}]}}}'
    ;;
  */api/templates/tmpl-majority)
    printf '%s\n200' '{"success":true,"data":{"verificationPipeline":{"passPolicy":"majority","maxRetries":3,"steps":[{"id":"s1","name":"Review","method":"code_review","critical":false}]}}}'
    ;;
  *)
    printf '%s\n404' '{"success":false}'
    ;;
esac
CURL_EOF
chmod +x "$FAKE_BIN/curl"

PROJECT_DIR="$WORK_DIR/project"
mkdir -p "$PROJECT_DIR/.crewly/tasks"

run_verify() {
  PATH="$FAKE_BIN:$PATH" CREWLY_API_URL="http://127.0.0.1:1" bash "$SCRIPT_DIR/execute.sh" "$1" 2>/dev/null
}

assert_json_field() {
  local desc="$1" input="$2" filter="$3" expected="$4"
  local OUTPUT actual
  OUTPUT=$(run_verify "$input") || true
  actual=$(printf '%s' "$OUTPUT" | jq -r "$filter" 2>/dev/null || echo "<no-json>")
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$filter' = '$expected', got '$actual'; output: $OUTPUT)"
    FAIL=$((FAIL + 1))
  fi
}

# One critical check that passes, one non-critical check that fails.
# Under critical_only the verdict is PASS; under "all" it would be FAIL.
CHECKLIST='{
  "status":"approved",
  "passPolicy":"critical_only",
  "items":[
    {"id":"crit-ok","type":"command","command":"true","description":"critical passes","critical":true},
    {"id":"minor-fail","type":"command","command":"false","description":"non-critical fails","critical":false}
  ]
}'
printf '%s' "$CHECKLIST" > "$WORK_DIR/checklist.json"
printf '%s' "$CHECKLIST" > "$PROJECT_DIR/.crewly/tasks/checklist-task-auto.json"

echo "verify-output: passPolicy resolution"

INPUT_EXPLICIT=$(jq -n --arg p "$WORK_DIR/checklist.json" --arg pp "$PROJECT_DIR" \
  '{taskId:"task-1",workerId:"w1",teamId:"t1",projectPath:$pp,checklistPath:$p}')
assert_json_field "explicit checklistPath: passPolicy from checklist survives" \
  "$INPUT_EXPLICIT" '.passPolicy' 'critical_only'
assert_json_field "explicit checklistPath: both checklist items are loaded as checks" \
  "$INPUT_EXPLICIT" '[.results[] | select(.name != "manual-review")] | length' '2'
assert_json_field "explicit checklistPath: non-critical failure is recorded" \
  "$INPUT_EXPLICIT" '.failedSteps | join(",")' 'minor-fail'
assert_json_field "explicit checklistPath: verdict honours critical_only" \
  "$INPUT_EXPLICIT" '.passed' 'true'

INPUT_AUTO=$(jq -n --arg pp "$PROJECT_DIR" \
  '{taskId:"task-auto",workerId:"w1",teamId:"t1",projectPath:$pp}')
assert_json_field "auto-discovered checklist: passPolicy from checklist survives" \
  "$INPUT_AUTO" '.passPolicy' 'critical_only'
assert_json_field "auto-discovered checklist: both checklist items are loaded as checks" \
  "$INPUT_AUTO" '[.results[] | select(.name != "manual-review")] | length' '2'
assert_json_field "auto-discovered checklist: verdict honours critical_only" \
  "$INPUT_AUTO" '.passed' 'true'

INPUT_ALL_POLICY=$(jq -n --arg p "$WORK_DIR/checklist-all.json" --arg pp "$PROJECT_DIR" \
  '{taskId:"task-1b",workerId:"w1",teamId:"t1",projectPath:$pp,checklistPath:$p}')
printf '%s' "$CHECKLIST" | jq '.passPolicy = "all"' > "$WORK_DIR/checklist-all.json"
assert_json_field "checklist with passPolicy=all: non-critical failure fails the verdict" \
  "$INPUT_ALL_POLICY" '.passed' 'false'

INPUT_TEMPLATE=$(jq -n --arg pp "$PROJECT_DIR" \
  '{taskId:"task-2",workerId:"w1",teamId:"t1",projectPath:$pp,templateId:"tmpl-majority"}')
assert_json_field "template pipeline: passPolicy comes from the pipeline when no checklist" \
  "$INPUT_TEMPLATE" '.passPolicy' 'majority'

INPUT_NONE=$(jq -n --arg pp "$PROJECT_DIR" \
  '{taskId:"task-3",workerId:"w1",teamId:"t1",projectPath:$pp}')
assert_json_field "no checklist, no template: passPolicy defaults to all" \
  "$INPUT_NONE" '.passPolicy' 'all'

INPUT_INLINE=$(jq -n --arg pp "$PROJECT_DIR" \
  '{taskId:"task-4",workerId:"w1",teamId:"t1",projectPath:$pp,checks:[{name:"ok",type:"command",command:"true",critical:true},{name:"bad",type:"command",command:"false",critical:false}]}')
assert_json_field "inline checks with default policy: all must pass" \
  "$INPUT_INLINE" '.passed' 'false'

echo ""
echo "verify-output: evidence first (#873)"

assert_json_field "evidence is the first key of the verdict" \
  '{"workItemId":"wi-ev"}' 'keys_unsorted[0]' 'evidence'
assert_json_field "evidence block is surfaced from output.evidence" \
  '{"workItemId":"wi-ev"}' '[.evidence[].type] | join(",")' 'artifact,command'
assert_json_field "no evidence warning when evidence is present" \
  '{"workItemId":"wi-ev"}' '.evidenceWarning' 'null'
assert_json_field "done without evidence is flagged" \
  '{"workItemId":"wi-noev"}' '.evidenceWarning | startswith("No completion evidence")' 'true'
assert_json_field "the evidence flag leads the feedback" \
  '{"workItemId":"wi-noev"}' '.feedback | startswith("No completion evidence")' 'true'
assert_json_field "blocked evidence is surfaced with its step" \
  '{"workItemId":"wi-blocked"}' '.evidenceWarning | contains("deploy: no creds")' 'true'
assert_json_field "an unreadable WorkItem gets empty evidence and no flag" \
  '{"workItemId":"wi-missing"}' '(.evidence | length | tostring) + "/" + (.evidenceWarning | tostring)' '0/null'

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
