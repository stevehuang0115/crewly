#!/bin/bash
# Get pool stats + active items for the team.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
# `GET /task-management/team-progress` (which aggregated `.md` files in
# `.crewly/tasks/`). The V3 task-pool's `/stats` and `/items` endpoints
# expose the same aggregate state on the WorkItem schema.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}" 2>/dev/null || echo '{}')

# `projectPath` is no longer required — V3 pool is a single global file —
# but if supplied, it is forwarded as a filter for callers expecting it.
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

STATS=$(api_call GET "/task-pool/stats" 2>/dev/null || echo '{"data":{}}')
# /task-pool/items is the whole pool (760 rows / 3.5 MB on 2026-09-21), far over
# the skill-output cap: plain api_call returned a {"truncated":true} envelope and
# this skill printed `workItems: []` as if the pool were empty. Fetch the full
# body, then reduce it HERE: only non-terminal items, compact fields, plus an
# `examined` count so a reader can tell "empty" from "unknown".
ITEMS_ERROR=""
if ! ITEMS=$(api_call_full GET "/task-pool/items" 2>/dev/null); then
  ITEMS='{"data":null}'
  ITEMS_ERROR="GET /task-pool/items failed or was replaced by a truncated envelope; workItems is UNKNOWN, not empty"
fi

# The items body goes in on stdin, not as --argjson: at 3.5 MB it exceeds
# the kernel's argument-size limit ("jq: Argument list too long").
OUT=$(printf '%s' "$ITEMS" | jq \
  --argjson stats "$STATS" \
  --arg projectPath "$PROJECT_PATH" \
  --arg itemsError "$ITEMS_ERROR" \
  '. as $items
   | ($items.data // $items.workItems) as $all
   | (if ($all | type) == "array" then $all else null end) as $rows
   | ["verified", "done", "cancelled", "failed"] as $terminal
   | {
    success: ($rows != null),
    projectPath: (if $projectPath == "" then null else $projectPath end),
    stats: ($stats.data // $stats),
    examined: (if $rows != null then ($rows | length) else 0 end),
    error: (if $rows != null then null
            elif $itemsError != "" then $itemsError
            else "GET /task-pool/items returned a body whose .data is not an array; workItems is UNKNOWN, not empty" end),
    workItems: (if $rows == null then [] else
      $rows
      | map(select(((.status // "") as $s | $terminal | index($s)) == null))
      | map({id, type, status, owner, target, title: ((.title // "") | .[0:120]), createdAt, startedAt})
    end)
  }
  | if .error == null then del(.error) else . end')
printf '%s\n' "$OUT"
# Exit non-zero when the item list is unknown, so callers cannot mistake it for empty.
printf '%s' "$OUT" | jq -e '.success' >/dev/null
