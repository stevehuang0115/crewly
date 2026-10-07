#!/bin/bash
# Mark a task as complete with a summary of the work done
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"wi-abc123\",\"sessionName\":\"dev-1\",\"summary\":\"Implemented feature X\",\"evidence\":[{\"type\":\"artifact\",\"path\":\"/abs/path/or/https-url\"},{\"type\":\"command\",\"command\":\"npm test\",\"exitCode\":0,\"outputTail\":\"42 passed\"}]}'"

# `workItemId` is the V3 identifier and the ONLY input that drives the API
# call (see the resolution block further down). `absoluteTaskPath` is the
# legacy V1 input: still ACCEPTED so pre-existing callers keep working, but
# it neither selects the WorkItem nor is required.
#
# It used to be `require_param`'d here, contradicting this skill's own
# resolution logic: passing `workItemId` alone — the documented V3 flow —
# returned `{"error":"Missing required parameter: absoluteTaskPath"}`, so
# every agent completing a V3 WorkItem had to bypass the skill and curl
# /api/task-pool/complete by hand. Same silent-friction class as the
# create-task `{workItem: ...}` wrapper: the skill rejected a request that
# was, by its own contract, correct.
if [ "$(printf '%s' "$INPUT" | jq -r 'type' 2>/dev/null || echo invalid)" != "object" ]; then
  error_exit "complete-task input must be a JSON object, e.g. {\"workItemId\":\"wi-abc123\",\"sessionName\":\"dev-1\",\"summary\":\"...\"}"
fi
WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // empty')
ABSOLUTE_TASK_PATH=$(printf '%s' "$INPUT" | jq -r '.absoluteTaskPath // empty')
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
SUMMARY=$(printf '%s' "$INPUT" | jq -r '.summary // empty')
# Unknown top-level fields are REJECTED, not ignored (CREW-267).
#
# `skipGates` was once parsed and forwarded, and nothing ever read it:
# `POST /task-pool/complete/:id` runs no quality gates (they live behind the
# `check-quality-gates` skill). On 2026-10-06 seven completions passed it,
# printed a bare `{}`, and looked closed when they were not. Accepting and
# ignoring a field is the worst disposition: the caller believes it did
# something, and nothing ever fails. So every field this skill does not use
# fails loudly, with its name, before any request is sent.
ALLOWED_FIELDS='["workItemId","absoluteTaskPath","sessionName","summary","output","evidence","verdict","feedback","taskId","artifacts","testResults","structured"]'
SKIP_GATES=$(printf '%s' "$INPUT" | jq -r 'has("skipGates")')
if [ "$SKIP_GATES" = "true" ]; then
  error_exit "skipGates is not supported by complete-task and never was — it was accepted and silently discarded. POST /task-pool/complete runs no quality gates, so there is nothing here to skip. Quality gates live behind the 'check-quality-gates' skill (POST /quality-gates/check); run or skip them there. Remove skipGates from this call."
fi
UNKNOWN_FIELDS=$(printf '%s' "$INPUT" | jq -r --argjson allowed "$ALLOWED_FIELDS" '[keys[] | select(. as $k | $allowed | index($k) | not)] | join(", ")')
if [ -n "$UNKNOWN_FIELDS" ]; then
  error_exit "complete-task does not accept: ${UNKNOWN_FIELDS}. Nothing was completed. Remove the field(s) and call again. Accepted fields: $(printf '%s' "$ALLOWED_FIELDS" | jq -r 'join(", ")'). Put structured results inside \"output\" and proof inside \"evidence\"."
fi
OUTPUT_JSON=$(printf '%s' "$INPUT" | jq -c '.output // empty')
# Evidence contract (#873): "done" needs evidence. Each entry is one of
#   {"type":"artifact","path":"<existing file, relative to the project/worktree, or https URL>"}
#   {"type":"command","command":"<cmd>","exitCode":0,"outputTail":"<last lines>"}
#   {"type":"blocked","step":"<step that failed>","reason":"<why>"}
# A `blocked` entry records the WorkItem as BLOCKED, not done. The server
# checks the rest (artifacts exist, exit codes are 0); this only checks the
# block is an array so a typo fails here instead of as a 400.
EVIDENCE_JSON=$(printf '%s' "$INPUT" | jq -c '.evidence // empty')
if [ -n "$EVIDENCE_JSON" ] && [ "$(printf '%s' "$EVIDENCE_JSON" | jq -r 'type')" != "array" ]; then
  error_exit "evidence must be a JSON array of entries, e.g. [{\"type\":\"artifact\",\"path\":\"/abs/file\"},{\"type\":\"command\",\"command\":\"npm test\",\"exitCode\":0}] — or [{\"type\":\"blocked\",\"step\":\"...\",\"reason\":\"...\"}] if you could not finish"
fi
# Reviewing someone's work (a "Verify: …" item): `verdict: "rejected"` plus
# `feedback` sends it back — the worker gets a retry carrying the feedback.
# Anything else (or nothing) accepts it.
VERDICT=$(printf '%s' "$INPUT" | jq -r '.verdict // empty')
FEEDBACK=$(printf '%s' "$INPUT" | jq -r '.feedback // empty')
if [ -n "$VERDICT" ] && [ "$VERDICT" != "rejected" ] && [ "$VERDICT" != "verified" ]; then
  error_exit "verdict must be \"rejected\" or \"verified\" (got \"${VERDICT}\")"
fi
if [ "$VERDICT" = "rejected" ] && [ -z "$FEEDBACK" ]; then
  error_exit "verdict \"rejected\" needs feedback: say what is wrong so the retry can fix it"
fi
require_param "sessionName" "$SESSION_NAME"
require_param "summary" "$SUMMARY"

# Optional structured VerificationRequest fields (for hierarchical workflows)
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.taskId // empty')
ARTIFACTS=$(printf '%s' "$INPUT" | jq -c '.artifacts // empty')
TEST_RESULTS=$(printf '%s' "$INPUT" | jq -r '.testResults // empty')
USE_STRUCTURED=$(printf '%s' "$INPUT" | jq -r '.structured // "false"')

# If structured mode is enabled and taskId is provided, send a [VERIFICATION REQUEST]
# to the orchestrator/team-leader before completing the task file.
if [ "$USE_STRUCTURED" = "true" ] && [ -n "$TASK_ID" ]; then
  VER_MESSAGE="---\n[VERIFICATION REQUEST]\nTask ID: ${TASK_ID}\nRequested by: ${SESSION_NAME}\n---\n\n## Summary\n${SUMMARY}"

  # Add artifacts if provided
  if [ -n "$ARTIFACTS" ] && [ "$ARTIFACTS" != "" ]; then
    ARTIFACT_LINES=$(printf '%s' "$ARTIFACTS" | jq -r '.[]? | "- **\(.name)** (\(.type)): \(.content)"' 2>/dev/null || true)
    if [ -n "$ARTIFACT_LINES" ]; then
      VER_MESSAGE="${VER_MESSAGE}\n\n## Artifacts\n${ARTIFACT_LINES}"
    fi
  fi

  # Add test results if provided
  if [ -n "$TEST_RESULTS" ]; then
    VER_MESSAGE="${VER_MESSAGE}\n\n## Test Results\n${TEST_RESULTS}"
  fi

  # Real newlines, not the literal "\n" the double-quoted strings above carry.
  _NL=$'\n'; VER_MESSAGE="${VER_MESSAGE//\\n/$_NL}"

  # Send verification request to orchestrator via chat API
  VER_BODY=$(jq -n --arg content "$VER_MESSAGE" --arg senderName "$SESSION_NAME" \
    '{content: $content, senderName: $senderName, senderType: "agent"}')
  api_call POST "/chat/agent-response" "$VER_BODY" || true
fi

# #186: If the task file was already moved from in_progress/ to done/ by
# report-status (via complete-by-session), succeed silently instead of failing.
if [ -n "$ABSOLUTE_TASK_PATH" ] && echo "$ABSOLUTE_TASK_PATH" | grep -q '/in_progress/'; then
  DONE_PATH="${ABSOLUTE_TASK_PATH/\/in_progress\///done/}"
  if [ -f "$DONE_PATH" ] && [ ! -f "$ABSOLUTE_TASK_PATH" ]; then
    echo '{"success":true,"message":"Task already completed (moved to done by report-status)"}'
    exit 0
  fi
fi

# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
# Resolve which V3 WorkItem to complete:
#   1. Explicit `workItemId` from input (preferred)
#   2. Fall back: query the pool for the agent's currently-running WI
#
# The legacy `absoluteTaskPath` input is still accepted but no longer
# drives the API call — it's only used for logging context. Callers
# should switch to passing `workItemId`.
#
# WORK_ITEM_ID was read from the input up top alongside the other params,
# so the identifier is known before any of the legacy path handling runs.
if [ -z "$WORK_ITEM_ID" ]; then
  POOL_RESP=$(api_call_full GET "/task-pool/items?status=running&target=${SESSION_NAME}" 2>/dev/null || echo '{}')
  WORK_ITEM_ID=$(echo "$POOL_RESP" | jq -r '.workItems[0].id // .data[0].id // empty' 2>/dev/null || true)
fi

# Neither an explicit `workItemId` nor the pool lookup produced a target.
# Fail loudly and name both accepted identifiers — exiting 0 here would let
# a worker believe its task was closed while the pool still shows it
# running, which is the silent no-op this skill must never perform.
if [ -z "$WORK_ITEM_ID" ]; then
  error_exit "Could not resolve a WorkItem to complete: no 'workItemId' was passed and no running WorkItem is assigned to session '${SESSION_NAME}'. Pass 'workItemId' explicitly — find it with GET /api/task-pool/items?status=running&target=${SESSION_NAME}. Note: 'absoluteTaskPath' is a legacy input and does NOT identify a WorkItem."
fi

# Hygiene #4: emit canonical body shape `{agentId, result:{summary, ...output}}`
# required by /api/task-pool/complete (task-pool.controller.ts `completeItem`).
# Prior shape `{summary, ..., result: $output}` 400'd because top-level summary
# was ignored (controller looks at result.summary) and `result` was overloaded
# with the output payload instead of the summary wrapper.
#
# The optional `output` is now MERGED into `result` alongside `summary` —
# this matches the controller's mergedOutput behavior (task-pool.controller.ts
# §405-419) which spreads result fields beyond `summary` into WorkItem.output.
#
# Precedence (per Sam #527 review note): jq's `+` operator is right-side-wins
# on key conflicts. The spread order here is `{summary: $summary} + $output`,
# so a caller-supplied `output.summary` WILL override the explicit `--summary`
# parameter. Intentional — callers passing structured output already have an
# authoritative summary in there; the explicit param is the fallback. If you
# need the param to win, swap the operands.
BODY=$(jq -n \
  --arg agentId "$SESSION_NAME" \
  --arg summary "$SUMMARY" \
  --argjson output "${OUTPUT_JSON:-null}" \
  --arg verdict "$VERDICT" \
  --arg feedback "$FEEDBACK" \
  --argjson evidence "${EVIDENCE_JSON:-null}" \
  '{
    agentId: $agentId,
    result: ({summary: $summary}
              + (if $output != null and ($output | type) == "object"
                 then $output
                 else {} end)
              + (if $verdict != "" then {verdict: $verdict} else {} end)
              + (if $feedback != "" then {feedback: $feedback} else {} end)
              + (if $evidence != null then {evidence: $evidence} else {} end))
  }')

COMPLETE_RESPONSE=$(api_call POST "/task-pool/complete/${WORK_ITEM_ID}" "$BODY")
# Always one result line naming the WorkItem (CREW-267): a bare `{}` read as
# "closed" when nothing said so. A non-empty object is passed through with
# the id added; an empty or non-JSON body gets an explicit line instead.
RESULT_LINE=$(printf '%s' "$COMPLETE_RESPONSE" | jq -c --arg id "$WORK_ITEM_ID" '
  if type == "object" and length > 0 then {workItemId: $id} + .
  else {success: true, workItemId: $id, message: ("WorkItem " + $id + " completion was accepted, but the server sent no details. Check it with GET /api/task-pool/items/" + $id + ".")}
  end' 2>/dev/null || true)
if [ -z "$RESULT_LINE" ]; then
  RESULT_LINE=$(jq -nc --arg id "$WORK_ITEM_ID" --arg raw "$COMPLETE_RESPONSE" \
    '{success: true, workItemId: $id, message: ("WorkItem " + $id + " completion was accepted; the server reply was not JSON."), raw: $raw}')
fi
printf '%s\n' "$RESULT_LINE"
# Warn-mode rollout (#873): the server accepts a completion without evidence
# for one release but says so. Repeat it on stderr so it is not missed.
EVIDENCE_WARNING=$(printf '%s' "$COMPLETE_RESPONSE" | jq -r '.warning // empty' 2>/dev/null || true)
if [ -n "$EVIDENCE_WARNING" ]; then
  jq -n --arg w "$EVIDENCE_WARNING" '{warning: $w}' >&2
fi

# The summary is stored on the WorkItem (result.summary) and in the project's
# task-history.json ledger. It is deliberately NOT saved to long-term memory:
# as a project "decision" it crowded real decisions out of recall (#833).
# Durable learnings go through `remember` / `record-learning` explicitly.
