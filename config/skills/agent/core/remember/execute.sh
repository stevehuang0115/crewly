#!/bin/bash
# Store a memory entry for future recall
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"agentId\":\"dev-1\",\"content\":\"The auth module uses JWT\",\"category\":\"architecture\",\"scope\":\"project\"}'"

AGENT_ID=$(echo "$INPUT" | jq -r '.agentId // empty')
CONTENT=$(echo "$INPUT" | jq -r '.content // empty')
CATEGORY=$(echo "$INPUT" | jq -r '.category // empty')
SCOPE=$(echo "$INPUT" | jq -r '.scope // empty')
require_param "agentId" "$AGENT_ID"
require_param "content" "$CONTENT"
require_param "category" "$CATEGORY"
require_param "scope" "$SCOPE"

# #187: Auto-inject projectPath from CREWLY_PROJECT_PATH env var when not provided
PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
if [ -z "$PROJECT_PATH" ] && [ -n "${CREWLY_PROJECT_PATH:-}" ]; then
  INPUT=$(echo "$INPUT" | jq --arg pp "$CREWLY_PROJECT_PATH" '. + {projectPath: $pp}')
fi

# Build body with required and optional fields
BODY=$(echo "$INPUT" | jq '{
  agentId: .agentId,
  content: .content,
  category: .category,
  scope: .scope
} +
  (if .projectPath then {projectPath: .projectPath} else {} end) +
  (if .metadata then {metadata: .metadata} else {} end)')

api_call POST "/memory/remember" "$BODY"
