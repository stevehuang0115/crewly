#!/bin/bash
# Claim the next available WorkItem from the V3 task-pool.
#
# V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. The
# legacy `/task-management/take-next` endpoint (which read `.md` files
# from `delegated/open/`) is no longer the source of truth.
#
# Input shape (backwards-compat from v1):
#   { "sessionName": "dev-1", "projectPath"?: "...", "taskGroup"?: "..." }
#
# `taskGroup` (legacy v1 milestone filter) maps to V3's `filters.types`.
# `teamMemberId` is no longer needed — V3 keys claims by `agentId`
# (= sessionName).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"dev-1\"}' or echo '{...}' | execute.sh"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
require_param "sessionName" "$SESSION_NAME"

# v1's `taskGroup` is informational metadata; V3 filters by WorkItem `type`
# instead. We pass the session name as the agent identity and let the pool
# pick the highest-scored available WI for this agent.
BODY=$(jq -n --arg agentId "$SESSION_NAME" '{agentId: $agentId}')

api_call POST "/task-pool/claim" "$BODY"
