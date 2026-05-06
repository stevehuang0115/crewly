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
ITEMS=$(api_call GET "/task-pool/items" 2>/dev/null || echo '{"data":[]}')

jq -n \
  --argjson stats "$STATS" \
  --argjson items "$ITEMS" \
  --arg projectPath "$PROJECT_PATH" \
  '{
    success: true,
    projectPath: (if $projectPath == "" then null else $projectPath end),
    stats: ($stats.data // $stats),
    workItems: ($items.data // $items.workItems // [])
  }'
