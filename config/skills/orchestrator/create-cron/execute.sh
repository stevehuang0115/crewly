#!/bin/bash
# Create a recurring cron task for an agent
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"cronExpression\":\"0 9 * * *\",\"timezone\":\"Asia/Shanghai\",\"targetAgent\":\"agent-session\",\"targetTeamId\":\"team-id\",\"taskDescription\":\"Daily report\"}'"

CRON=$(echo "$INPUT" | jq -r '.cronExpression // empty')
TZ_VAL=$(echo "$INPUT" | jq -r '.timezone // "UTC"')
TARGET=$(echo "$INPUT" | jq -r '.targetAgent // empty')
TEAM=$(echo "$INPUT" | jq -r '.targetTeamId // empty')
DESC=$(echo "$INPUT" | jq -r '.taskDescription // empty')
require_param "cronExpression" "$CRON"
require_param "targetAgent" "$TARGET"
require_param "targetTeamId" "$TEAM"
require_param "taskDescription" "$DESC"

BODY=$(jq -n \
  --arg cron "$CRON" --arg tz "$TZ_VAL" \
  --arg target "$TARGET" --arg team "$TEAM" \
  --arg desc "$DESC" \
  '{cronExpression: $cron, timezone: $tz, targetAgent: $target, targetTeamId: $team, taskDescription: $desc, createdBy: "orchestrator"}')

api_call POST "/cron-tasks" "$BODY"
