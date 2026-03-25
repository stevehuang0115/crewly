#!/bin/bash
# Retrieve accumulated context including memories, learnings, and project knowledge
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"agentId\":\"dev-1\",\"agentRole\":\"developer\",\"projectPath\":\"...\"}' or echo '{...}' | execute.sh"

AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
AGENT_ROLE=$(printf '%s' "$INPUT" | jq -r '.agentRole // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
require_param "agentId" "$AGENT_ID"
require_param "agentRole" "$AGENT_ROLE"
require_param "projectPath" "$PROJECT_PATH"

BODY=$(jq -n \
  --arg agentId "$AGENT_ID" \
  --arg agentRole "$AGENT_ROLE" \
  --arg projectPath "$PROJECT_PATH" \
  '{agentId: $agentId, agentRole: $agentRole, projectPath: $projectPath}')

api_call POST "/memory/my-context" "$BODY"
