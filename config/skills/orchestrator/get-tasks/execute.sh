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
# No argument and no stdin gives an empty string, not '{}'. Without this
# default LIMIT came out empty, `--argjson limit ""` failed, and a bare
# `get-tasks` reported "could not read the task pool".
[ -n "${INPUT//[[:space:]]/}" ] || INPUT='{}'

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
STATUS=$(printf '%s' "$INPUT" | jq -r '.status // empty')
ALL=$(printf '%s' "$INPUT" | jq -r '.all // false')
LIMIT=$(printf '%s' "$INPUT" | jq -r '(.limit // 50) | tonumber? // 50')
TARGET=$(printf '%s' "$INPUT" | jq -r '.target // empty')

STATS=$(api_call GET "/task-pool/stats" 2>/dev/null || echo '{"data":{}}')

# The item list goes through a pipe, never argv, however large the pool is.
# api_call_full bypasses the skill output cap (or reads the parked body); it
# fails rather than hand back a truncation envelope that would read as "no
# work items". An unknown list is reported as success:false and exit 1.
if ! ITEMS=$(api_call_full GET "/task-pool/items" 2>/dev/null); then
  ITEMS='{"data":null}'
fi

OUT=$(printf '%s' "$ITEMS" \
  | jq -c \
      --argjson stats "$STATS" \
      --arg projectPath "$PROJECT_PATH" \
      --arg status "$STATUS" \
      --arg all "$ALL" \
      --arg target "$TARGET" \
      --argjson limit "$LIMIT" \
      '
      def finished: ["done","verified","cancelled","failed","rejected"];
      (.data // .workItems) as $raw
      | if ($raw | type) != "array" then
          {
            success: false,
            projectPath: (if $projectPath == "" then null else $projectPath end),
            stats: ($stats.data // $stats),
            examined: 0,
            error: "GET /task-pool/items failed or did not return a list; workItems is UNKNOWN, not empty"
          }
        else
          $raw as $items
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
              examined: ($items | length),
              matched: ($matched | length),
              shown: ([$matched | length, $limit] | min),
              workItems: ($matched[:$limit] | map({
                id, title, status, target,
                createdAt,
                blockedReason: (.blockedReason // null)
              })),
              hint: "Compact view: open items only, newest first. Finished ones: {\"all\":true}. One agent: {\"target\":\"<session>\"}."
            }
        end
      ') || OUT='{"success":false,"examined":0,"error":"could not read the task pool"}'
printf '%s\n' "$OUT"
# Exit non-zero when the item list is unknown, so callers cannot mistake it for empty.
printf '%s' "$OUT" | jq -e '.success' >/dev/null
