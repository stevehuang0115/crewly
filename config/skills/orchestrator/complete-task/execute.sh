#!/bin/bash
# Mark a task as complete via the task management system
# Passes through all input fields including optional 'output' for schema validation
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"taskId\":\"...\",\"result\":\"success\"}'"

api_call POST "/task-management/complete" "$INPUT"
