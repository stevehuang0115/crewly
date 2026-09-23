#!/bin/bash
# Get pool stats + the open work items, compactly.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# `GET /task-management/team-progress` (which aggregated `.md` files in
# `.crewly/tasks/`). The V3 task-pool's `/stats` and `/items` endpoints
# expose the same aggregate state on the WorkItem schema.
#
# Output is kept small on purpose (2026-09-23): whatever this prints stays in
# the orchestrator's conversation and is re-read on every turn after. The full
# pool was 762 items / 3.5MB; printing it cost ~280k tokens, and past ~1MB the
# old `jq --argjson` hit "argument list too long" and silently returned [].
#
# Input (all optional):
#   {"status":"blocked"}        one status (or comma-separated list)
#   {"all":true}                include finished items (done/verified/…)
#   {"limit":50}                max items, newest first (default 50)
#   {"target":"<session>"}      only items for one agent
#   {"projectPath":"..."}       echoed back for callers that pass it

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}" 2>/dev/null || echo '{}')

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
STATUS=$(printf '%s' "$INPUT" | jq -r '.status // empty')
ALL=$(printf '%s' "$INPUT" | jq -r '.all // false')
LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // 50')
TARGET=$(printf '%s' "$INPUT" | jq -r '.target // empty')

STATS=$(api_call GET "/task-pool/stats" 2>/dev/null || echo '{"data":{}}')

# The item list goes through a pipe, never argv, however large the pool is,
# and bypasses the skill output cap — it is filtered down below, and a
# truncation envelope in its place would read as "no work items".
CREWLY_SKILL_MAX_OUTPUT_BYTES=0 api_call GET "/task-pool/items" 2>/dev/null \
  | jq -c \
      --argjson stats "$STATS" \
      --arg projectPath "$PROJECT_PATH" \
      --arg status "$STATUS" \
      --arg all "$ALL" \
      --arg target "$TARGET" \
      --argjson limit "$LIMIT" \
      '
      def finished: ["done","verified","cancelled","failed","rejected"];
      (.data // .workItems // []) as $items
      | ($items
          | map(select(
              ($status == "" or (.status as $s | ($status | split(",") | index($s)) != null))
              and ($all == "true" or $status != "" or ((.status as $s | finished | index($s)) == null))
              and ($target == "" or .target == $target)
            ))
          | sort_by(.createdAt) | reverse) as $matched
      | {
          success: true,
          projectPath: (if $projectPath == "" then null else $projectPath end),
          stats: ($stats.data // $stats),
          matched: ($matched | length),
          shown: ([$matched | length, $limit] | min),
          workItems: ($matched[:$limit] | map({
            id, title, status, target,
            createdAt,
            blockedReason: (.blockedReason // null)
          })),
          hint: "Compact view: open items only, newest first. Finished ones: {\"all\":true}. One agent: {\"target\":\"<session>\"}."
        }
      ' \
  || echo '{"success":false,"error":"could not read the task pool"}'
