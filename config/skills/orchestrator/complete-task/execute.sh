#!/bin/bash
# Mark a WorkItem complete via the V3 task-pool.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# the v1 `/task-management/complete` endpoint. Optional `output` is stored
# on the WorkItem (replaces `<taskId>.output.json`) before completion.
#
# Input shape:
#   { "workItemId": "abc-123", "summary": "...", "output"?: { ... },
#     "evidence"?: [ {"type":"artifact","path":"..."} |
#                    {"type":"command","command":"...","exitCode":0,"outputTail":"..."} |
#                    {"type":"blocked","step":"...","reason":"..."} ] }
#
# `evidence` (#873) is sent as result.evidence. The server checks it: missing
# artifacts and non-zero exit codes are refused, a `blocked` entry records the
# item as blocked instead of done, and no evidence at all is accepted this
# release with a `warning` (refused from the next).
#
# Backwards-compat: a `taskId` field is accepted as alias for `workItemId`.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"workItemId\":\"abc-123\",\"summary\":\"Done\"}'"

WORK_ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.workItemId // .taskId // empty')
SUMMARY=$(printf '%s' "$INPUT" | jq -r '.summary // .result // empty')
OUTPUT=$(printf '%s' "$INPUT" | jq -c '.output // empty')
# Hygiene #4: agentId is required by the controller's completeItem validator.
# Orchestrator-driven completions default to "crewly-orc" but accept an
# explicit override (some flows complete on behalf of the agent that ran the
# work — pass that session name instead).
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // .sessionName // "crewly-orc"')

EVIDENCE=$(printf '%s' "$INPUT" | jq -c '.evidence // empty')
if [ -n "$EVIDENCE" ] && [ "$(printf '%s' "$EVIDENCE" | jq -r 'type')" != "array" ]; then
  error_exit "evidence must be a JSON array, e.g. [{\"type\":\"artifact\",\"path\":\"/abs/file\"}]"
fi

require_param "workItemId" "$WORK_ITEM_ID"

# Persist structured output on the WorkItem before completing, so that
# `verify-output` can read it back via `GET /task-pool/items/:id`.
if [ -n "$OUTPUT" ] && [ "$OUTPUT" != "null" ] && [ "$OUTPUT" != "" ]; then
  OUTPUT_BODY=$(jq -n --argjson output "$OUTPUT" '{output: $output}')
  api_call POST "/task-pool/items/${WORK_ITEM_ID}/output" "$OUTPUT_BODY" >/dev/null 2>&1 || true
fi

# Hygiene #4: emit canonical body shape `{agentId, result:{summary}}`
# required by /api/task-pool/complete (task-pool.controller.ts `completeItem`).
# Prior shape `{summary}` 400'd with `agentId is required` + `summary
# required in body.result`. The controller enforces non-empty summary, so
# bail early here too rather than send `{agentId, result:{}}` and let the
# server reject it.
if [ -z "$SUMMARY" ]; then
  error_exit "summary is required (controller enforces non-empty body.result.summary)"
fi
COMPLETE_BODY=$(jq -n \
  --arg agentId "$AGENT_ID" \
  --arg summary "$SUMMARY" \
  --argjson evidence "${EVIDENCE:-null}" \
  '{agentId: $agentId, result: ({summary: $summary} + (if $evidence != null then {evidence: $evidence} else {} end))}')

COMPLETE_RESPONSE=$(api_call POST "/task-pool/complete/${WORK_ITEM_ID}" "$COMPLETE_BODY")
printf '%s\n' "$COMPLETE_RESPONSE"
EVIDENCE_WARNING=$(printf '%s' "$COMPLETE_RESPONSE" | jq -r '.warning // empty' 2>/dev/null || true)
if [ -n "$EVIDENCE_WARNING" ]; then
  jq -n --arg w "$EVIDENCE_WARNING" '{warning: $w}' >&2
fi
