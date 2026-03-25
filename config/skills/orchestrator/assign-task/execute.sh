#!/bin/bash
# Assign a task to an agent via the task management system
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"taskId\":\"...\",\"assignee\":\"agent-session\"}'"

# Pass the full input as the request body
api_call POST "/task-management/assign" "$INPUT"
