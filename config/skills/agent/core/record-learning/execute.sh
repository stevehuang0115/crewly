#!/bin/bash
# Record a learning or insight for team knowledge sharing
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"agentId\":\"dev-1\",\"agentRole\":\"developer\",\"projectPath\":\"...\",\"learning\":\"...\"}' or echo '{...}' | execute.sh"

AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
AGENT_ROLE=$(printf '%s' "$INPUT" | jq -r '.agentRole // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
LEARNING=$(printf '%s' "$INPUT" | jq -r '.learning // empty')
require_param "agentId" "$AGENT_ID"
require_param "agentRole" "$AGENT_ROLE"
require_param "projectPath" "$PROJECT_PATH"
require_param "learning" "$LEARNING"

# Build body with required and optional fields
BODY=$(printf '%s' "$INPUT" | jq '{
  agentId: .agentId,
  agentRole: .agentRole,
  projectPath: .projectPath,
  learning: .learning
} +
  (if .relatedTask then {relatedTask: .relatedTask} else {} end) +
  (if .relatedFiles then {relatedFiles: .relatedFiles} else {} end)')

api_call POST "/memory/record-learning" "$BODY"
