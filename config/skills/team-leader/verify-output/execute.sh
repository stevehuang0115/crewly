#!/bin/bash
# Verify a completed task's output against the team's verification pipeline.
# Reads the task output and runs verification steps based on the team template.
#
# Supports two modes:
# 1. Explicit checks: pass checks[] array directly (legacy behavior)
# 2. Template pipeline: pass templateId to load verification steps from template
#
# When templateId is provided and checks is empty, pipeline steps are loaded
# from the template API and executed according to the passPolicy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"taskId\":\"...\",\"taskPath\":\"...\",\"workerId\":\"...\",\"teamId\":\"...\",\"projectPath\":\"...\",\"templateId\":\"dev-fullstack\",\"checks\":[...]}'"

TASK_ID=$(printf '%s' "$INPUT" | jq -r '.taskId // empty')
TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.taskPath // empty')
WORKER_ID=$(printf '%s' "$INPUT" | jq -r '.workerId // empty')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
TEMPLATE_ID=$(printf '%s' "$INPUT" | jq -r '.templateId // empty')
CHECKLIST_PATH=$(printf '%s' "$INPUT" | jq -r '.checklistPath // empty')
CHECKS=$(printf '%s' "$INPUT" | jq -c '.checks // []')

# At least taskPath or taskId is needed
if [ -z "$TASK_PATH" ] && [ -z "$TASK_ID" ]; then
  error_exit "Either taskPath or taskId is required"
fi

# Read task output if taskPath is provided
TASK_OUTPUT=""
if [ -n "$TASK_PATH" ]; then
  TASK_READ_BODY=$(jq -n --arg taskPath "$TASK_PATH" '{taskPath: $taskPath}')
  TASK_DATA=$(api_call POST "/task-management/read-task" "$TASK_READ_BODY" 2>/dev/null || echo '{}')
  TASK_OUTPUT=$(echo "$TASK_DATA" | jq -r '.data.content // empty' 2>/dev/null || true)
fi

# If taskId is provided, try to get output from task tracking
if [ -n "$TASK_ID" ]; then
  OUTPUT_BODY=$(jq -n --arg taskId "$TASK_ID" '{taskId: $taskId}')
  OUTPUT_DATA=$(api_call POST "/task-management/get-output" "$OUTPUT_BODY" 2>/dev/null || echo '{}')
  TASK_OUTPUT_FROM_ID=$(echo "$OUTPUT_DATA" | jq -r '.data.output // empty' 2>/dev/null || true)
  [ -z "$TASK_OUTPUT" ] && TASK_OUTPUT="$TASK_OUTPUT_FROM_ID"
fi

# =============================================================================
# Pre-approved checklist loading (from design-checklist skill)
# =============================================================================

# If checklistPath is provided, load pre-approved checklist items as checks.
# This takes priority over template pipeline and inline checks.
if [ -n "$CHECKLIST_PATH" ] && [ -f "$CHECKLIST_PATH" ]; then
  CHECKLIST_DATA=$(cat "$CHECKLIST_PATH" 2>/dev/null || echo '{}')
  CHECKLIST_STATUS=$(echo "$CHECKLIST_DATA" | jq -r '.status // "unknown"' 2>/dev/null || true)

  if [ "$CHECKLIST_STATUS" = "approved" ]; then
    # Convert checklist items to verification checks
    CHECKS=$(echo "$CHECKLIST_DATA" | jq -c '
      [.items[] | {
        name: .id,
        type: .type,
        command: (.command // empty),
        pattern: (.pattern // empty),
        description: .description,
        critical: (.critical // false)
      }]
    ' 2>/dev/null || echo '[]')

    PASS_POLICY=$(echo "$CHECKLIST_DATA" | jq -r '.passPolicy // "critical_only"' 2>/dev/null || echo "critical_only")
  else
    echo '{"error":"Checklist exists but is not approved (status: '"$CHECKLIST_STATUS"'). Approve first via POST /api/task-management/'$TASK_ID'/checklist/approve"}' >&2
    # Fall through to template/inline checks
  fi

# If no checklistPath but taskId, try to find checklist automatically
elif [ -n "$TASK_ID" ] && [ -n "$PROJECT_PATH" ]; then
  AUTO_CHECKLIST="${PROJECT_PATH}/.crewly/tasks/checklist-${TASK_ID}.json"
  if [ -f "$AUTO_CHECKLIST" ]; then
    CHECKLIST_STATUS=$(jq -r '.status // "unknown"' "$AUTO_CHECKLIST" 2>/dev/null || true)
    if [ "$CHECKLIST_STATUS" = "approved" ]; then
      CHECKS=$(jq -c '[.items[] | {name: .id, type: .type, command: (.command // empty), pattern: (.pattern // empty), description: .description, critical: (.critical // false)}]' "$AUTO_CHECKLIST" 2>/dev/null || echo '[]')
      PASS_POLICY=$(jq -r '.passPolicy // "critical_only"' "$AUTO_CHECKLIST" 2>/dev/null || echo "critical_only")
    fi
  fi
fi

# =============================================================================
# Pipeline loading: convert template pipeline steps to checks
# =============================================================================

PASS_POLICY="all"
MAX_RETRIES=2
CHECK_COUNT=$(echo "$CHECKS" | jq 'length')

if [ "$CHECK_COUNT" = "0" ] && [ -n "$TEMPLATE_ID" ]; then
  # Load pipeline from template API
  TEMPLATE_DATA=$(api_call GET "/templates/${TEMPLATE_ID}" 2>/dev/null || echo '{}')
  TEMPLATE_SUCCESS=$(echo "$TEMPLATE_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")

  if [ "$TEMPLATE_SUCCESS" = "true" ]; then
    PIPELINE=$(echo "$TEMPLATE_DATA" | jq -c '.data.verificationPipeline // {}' 2>/dev/null || echo '{}')
    PASS_POLICY=$(echo "$PIPELINE" | jq -r '.passPolicy // "all"')
    MAX_RETRIES=$(echo "$PIPELINE" | jq -r '.maxRetries // 2')
    STEPS=$(echo "$PIPELINE" | jq -c '.steps // []')
    STEP_COUNT=$(echo "$STEPS" | jq 'length')

    # Convert pipeline steps to checks format
    CHECKS="[]"
    for i in $(seq 0 $((STEP_COUNT - 1))); do
      STEP_ID=$(echo "$STEPS" | jq -r ".[$i].id // \"step-${i}\"")
      STEP_NAME=$(echo "$STEPS" | jq -r ".[$i].name // \"Step ${i}\"")
      STEP_METHOD=$(echo "$STEPS" | jq -r ".[$i].method // \"manual_review\"")
      STEP_CRITICAL=$(echo "$STEPS" | jq -r ".[$i].critical // false")
      STEP_CONFIG=$(echo "$STEPS" | jq -c ".[$i].config // {}")

      case "$STEP_METHOD" in
        quality_gates)
          # Map quality gates to command checks using the gates config
          GATES=$(echo "$STEP_CONFIG" | jq -r '.gates // [] | .[]' 2>/dev/null || true)
          if [ -n "$GATES" ] && [ -n "$PROJECT_PATH" ]; then
            for GATE in $GATES; do
              GATE_CMD=""
              case "$GATE" in
                typecheck) GATE_CMD="npm run typecheck 2>&1 || npx tsc --noEmit 2>&1" ;;
                tests)     GATE_CMD="npm test 2>&1" ;;
                build)     GATE_CMD="npm run build 2>&1" ;;
                lint)      GATE_CMD="npm run lint 2>&1" ;;
              esac
              if [ -n "$GATE_CMD" ]; then
                CHECKS=$(echo "$CHECKS" | jq \
                  --arg name "${STEP_ID}-${GATE}" \
                  --arg command "$GATE_CMD" \
                  --arg critical "$STEP_CRITICAL" \
                  '. + [{name: $name, command: $command, type: "command", critical: ($critical == "true")}]')
              fi
            done
          else
            # No gates specified — default to build check
            CHECKS=$(echo "$CHECKS" | jq \
              --arg name "$STEP_ID" \
              --arg command "npm run build 2>&1" \
              --arg critical "$STEP_CRITICAL" \
              '. + [{name: $name, command: $command, type: "command", critical: ($critical == "true")}]')
          fi
          ;;
        e2e_test)
          # Map to e2e test command
          FRAMEWORK=$(echo "$STEP_CONFIG" | jq -r '.framework // "playwright"')
          TEST_DIR=$(echo "$STEP_CONFIG" | jq -r '.testDir // "tests/e2e"')
          CHECKS=$(echo "$CHECKS" | jq \
            --arg name "$STEP_ID" \
            --arg command "npx ${FRAMEWORK} test ${TEST_DIR} 2>&1" \
            --arg critical "$STEP_CRITICAL" \
            '. + [{name: $name, command: $command, type: "command", critical: ($critical == "true")}]')
          ;;
        code_review|screenshot_review|gemini_vision|content_check|fact_check|source_verify|data_validate|browser_test|custom_script|manual_review)
          # These methods require TL judgment — record as manual review steps
          CHECKS=$(echo "$CHECKS" | jq \
            --arg name "$STEP_ID" \
            --arg desc "$STEP_NAME" \
            --arg method "$STEP_METHOD" \
            --arg critical "$STEP_CRITICAL" \
            '. + [{name: $name, type: "manual", method: $method, description: $desc, critical: ($critical == "true")}]')
          ;;
        *)
          # Unknown method — skip
          CHECKS=$(echo "$CHECKS" | jq \
            --arg name "$STEP_ID" \
            --arg method "$STEP_METHOD" \
            --arg critical "$STEP_CRITICAL" \
            '. + [{name: $name, type: "skip", method: $method, critical: ($critical == "true")}]')
          ;;
      esac
    done

    CHECK_COUNT=$(echo "$CHECKS" | jq 'length')
  fi
fi

# =============================================================================
# Run verification checks
# =============================================================================

RESULTS="[]"
TOTAL_PASSED=0
TOTAL_FAILED=0
CRITICAL_PASSED=0
CRITICAL_FAILED=0
FAILED_STEPS="[]"

if [ "$CHECK_COUNT" = "0" ]; then
  # No checks at all — report a pass-through verification
  RESULTS=$(jq -n '[{
    "name": "manual-review",
    "passed": true,
    "critical": false,
    "message": "No automated checks configured. Task output available for manual review."
  }]')
  TOTAL_PASSED=1
else
  for i in $(seq 0 $((CHECK_COUNT - 1))); do
    CHECK_NAME=$(echo "$CHECKS" | jq -r ".[$i].name // \"check-${i}\"")
    CHECK_CMD=$(echo "$CHECKS" | jq -r ".[$i].command // empty")
    CHECK_TYPE=$(echo "$CHECKS" | jq -r ".[$i].type // \"command\"")
    CHECK_CRITICAL=$(echo "$CHECKS" | jq -r ".[$i].critical // false")

    if [ "$CHECK_TYPE" = "command" ] && [ -n "$CHECK_CMD" ] && [ -n "$PROJECT_PATH" ]; then
      # Execute the verification command in the project directory
      CHECK_OUTPUT=""
      CHECK_PASSED=true
      CHECK_OUTPUT=$(cd "$PROJECT_PATH" && eval "$CHECK_CMD" 2>&1) || CHECK_PASSED=false

      # Truncate output to avoid huge payloads
      CHECK_OUTPUT=$(echo "$CHECK_OUTPUT" | tail -50)

      if [ "$CHECK_PASSED" = "true" ]; then
        TOTAL_PASSED=$((TOTAL_PASSED + 1))
        [ "$CHECK_CRITICAL" = "true" ] && CRITICAL_PASSED=$((CRITICAL_PASSED + 1))
      else
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        [ "$CHECK_CRITICAL" = "true" ] && CRITICAL_FAILED=$((CRITICAL_FAILED + 1))
        FAILED_STEPS=$(echo "$FAILED_STEPS" | jq --arg name "$CHECK_NAME" '. + [$name]')
      fi

      RESULTS=$(echo "$RESULTS" | jq \
        --arg name "$CHECK_NAME" \
        --arg passed "$CHECK_PASSED" \
        --arg output "$CHECK_OUTPUT" \
        --arg critical "$CHECK_CRITICAL" \
        '. + [{name: $name, passed: ($passed == "true"), critical: ($critical == "true"), output: $output}]')
    elif [ "$CHECK_TYPE" = "content-scan" ]; then
      # Content-based verification (check task output contains expected patterns)
      CHECK_PATTERN=$(echo "$CHECKS" | jq -r ".[$i].pattern // empty")
      if [ -n "$CHECK_PATTERN" ] && [ -n "$TASK_OUTPUT" ]; then
        if echo "$TASK_OUTPUT" | grep -qiE "$CHECK_PATTERN"; then
          TOTAL_PASSED=$((TOTAL_PASSED + 1))
          [ "$CHECK_CRITICAL" = "true" ] && CRITICAL_PASSED=$((CRITICAL_PASSED + 1))
          RESULTS=$(echo "$RESULTS" | jq --arg name "$CHECK_NAME" --arg critical "$CHECK_CRITICAL" \
            '. + [{name: $name, passed: true, critical: ($critical == "true"), output: "Pattern found"}]')
        else
          TOTAL_FAILED=$((TOTAL_FAILED + 1))
          [ "$CHECK_CRITICAL" = "true" ] && CRITICAL_FAILED=$((CRITICAL_FAILED + 1))
          FAILED_STEPS=$(echo "$FAILED_STEPS" | jq --arg name "$CHECK_NAME" '. + [$name]')
          RESULTS=$(echo "$RESULTS" | jq --arg name "$CHECK_NAME" --arg critical "$CHECK_CRITICAL" \
            '. + [{name: $name, passed: false, critical: ($critical == "true"), output: "Pattern not found"}]')
        fi
      else
        TOTAL_PASSED=$((TOTAL_PASSED + 1))
        [ "$CHECK_CRITICAL" = "true" ] && CRITICAL_PASSED=$((CRITICAL_PASSED + 1))
        RESULTS=$(echo "$RESULTS" | jq --arg name "$CHECK_NAME" --arg critical "$CHECK_CRITICAL" \
          '. + [{name: $name, passed: true, critical: ($critical == "true"), output: "Skipped (no pattern or output)"}]')
      fi
    elif [ "$CHECK_TYPE" = "manual" ]; then
      # Manual review steps — require TL judgment, auto-pass with note
      CHECK_METHOD=$(echo "$CHECKS" | jq -r ".[$i].method // \"manual_review\"")
      CHECK_DESC=$(echo "$CHECKS" | jq -r ".[$i].description // \"Manual review required\"")
      TOTAL_PASSED=$((TOTAL_PASSED + 1))
      [ "$CHECK_CRITICAL" = "true" ] && CRITICAL_PASSED=$((CRITICAL_PASSED + 1))
      RESULTS=$(echo "$RESULTS" | jq \
        --arg name "$CHECK_NAME" \
        --arg method "$CHECK_METHOD" \
        --arg desc "$CHECK_DESC" \
        --arg critical "$CHECK_CRITICAL" \
        '. + [{name: $name, passed: true, critical: ($critical == "true"), output: ("Requires TL judgment: " + $desc), method: $method, requiresReview: true}]')
    else
      # Unknown check type — skip
      RESULTS=$(echo "$RESULTS" | jq --arg name "$CHECK_NAME" --arg type "$CHECK_TYPE" --arg critical "$CHECK_CRITICAL" \
        '. + [{name: $name, passed: true, critical: ($critical == "true"), output: ("Skipped: unknown check type " + $type)}]')
      TOTAL_PASSED=$((TOTAL_PASSED + 1))
      [ "$CHECK_CRITICAL" = "true" ] && CRITICAL_PASSED=$((CRITICAL_PASSED + 1))
    fi
  done
fi

# =============================================================================
# Calculate pass/fail based on passPolicy
# =============================================================================

TOTAL_CHECKS=$((TOTAL_PASSED + TOTAL_FAILED))
if [ "$TOTAL_CHECKS" -gt 0 ]; then
  SCORE=$(echo "scale=0; $TOTAL_PASSED * 100 / $TOTAL_CHECKS" | bc)
else
  SCORE=100
fi

# Determine overall pass based on passPolicy
case "$PASS_POLICY" in
  critical_only)
    # Only critical steps must pass
    PASSED=$( [ "$CRITICAL_FAILED" -eq 0 ] && echo "true" || echo "false" )
    ;;
  majority)
    # >50% of total checks must pass
    HALF=$(echo "scale=0; $TOTAL_CHECKS / 2" | bc)
    PASSED=$( [ "$TOTAL_PASSED" -gt "$HALF" ] && echo "true" || echo "false" )
    ;;
  all|*)
    # All checks must pass (default)
    PASSED=$( [ "$TOTAL_FAILED" -eq 0 ] && echo "true" || echo "false" )
    ;;
esac

# Build feedback message
if [ "$PASSED" = "true" ]; then
  FEEDBACK="Verification passed (${TOTAL_PASSED}/${TOTAL_CHECKS} checks, policy: ${PASS_POLICY})."
else
  FEEDBACK="Verification failed: ${TOTAL_FAILED}/${TOTAL_CHECKS} checks failed (policy: ${PASS_POLICY})."
fi

# Check if any results require manual TL review
REQUIRES_REVIEW=$(echo "$RESULTS" | jq '[.[] | select(.requiresReview == true)] | length')
if [ "$REQUIRES_REVIEW" -gt 0 ]; then
  FEEDBACK="${FEEDBACK} ${REQUIRES_REVIEW} step(s) require Team Leader review."
fi

jq -n \
  --arg passed "$PASSED" \
  --arg score "$SCORE" \
  --arg feedback "$FEEDBACK" \
  --arg passPolicy "$PASS_POLICY" \
  --argjson failedSteps "$FAILED_STEPS" \
  --argjson results "$RESULTS" \
  --arg taskId "$TASK_ID" \
  --arg workerId "$WORKER_ID" \
  --arg templateId "$TEMPLATE_ID" \
  '{
    passed: ($passed == "true"),
    score: ($score | tonumber),
    feedback: $feedback,
    passPolicy: $passPolicy,
    failedSteps: $failedSteps,
    results: $results,
    taskId: $taskId,
    workerId: $workerId,
    templateId: $templateId
  }'
