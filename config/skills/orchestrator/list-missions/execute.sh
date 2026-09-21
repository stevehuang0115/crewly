#!/bin/bash
# list-missions — compact view of Missions (OKRs) with approval + KR progress.
# Usage: execute.sh [--pending] [--full]
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

PENDING="false"; FULL="false"
for arg in "$@"; do
  case "$arg" in
    --pending) PENDING="true" ;;
    --full) FULL="true" ;;
  esac
done

RAW=$(api_call_full GET "/missions") || exit 1
if [ "$FULL" = "true" ]; then printf '%s\n' "$RAW"; exit 0; fi

printf '%s' "$RAW" | jq --arg pending "$PENDING" '
  def kr: {title, current, target, unit, status, measurementSource};
  def compact: {
    id, level, objective, status,
    approval: (.approval.state // "approved"),
    parentMissionId,
    keyResults: [(.keyResults // [])[] | kr]
  };
  (.data // .) as $all
  | ($all | map(compact)) as $items
  | (if $pending == "true" then ($items | map(select(.approval == "pending_approval"))) else $items end) as $shown
  | {
      count: ($shown | length),
      pendingApproval: ($items | map(select(.approval == "pending_approval")) | length),
      missions: $shown
    }'
