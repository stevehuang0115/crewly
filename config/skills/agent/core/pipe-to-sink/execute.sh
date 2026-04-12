#!/usr/bin/env bash
# pipe-to-sink: Route structured data to a registered sink via the Data API.
#
# Input (JSON):
#   {
#     "sinkId": "steve-inputs",
#     "data": { "title": "...", "source": "slack", ... },
#     "projectPath": "/path/to/project"    (optional — falls back to CREWLY_PROJECT_PATH)
#   }
#
# Calls: POST /api/v2/data/sinks/:sinkId
# Returns: JSON with the created DataObject ID on success, or error details.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sinkId\":\"...\",\"data\":{...}}' or echo '{...}' | execute.sh"

SINK_ID=$(printf '%s' "$INPUT" | jq -r '.sinkId // empty')
require_param "sinkId" "$SINK_ID"

DATA=$(printf '%s' "$INPUT" | jq '.data // empty')
if [ "$DATA" = "null" ] || [ "$DATA" = "" ] || [ "$DATA" = "empty" ]; then
  error_exit "Missing required parameter: data"
fi

# Resolve projectPath: explicit > env var > omit
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
if [ -z "$PROJECT_PATH" ] && [ -n "${CREWLY_PROJECT_PATH:-}" ]; then
  PROJECT_PATH="$CREWLY_PROJECT_PATH"
fi

# Build request body
BODY=$(jq -n \
  --argjson data "$DATA" \
  --arg projectPath "$PROJECT_PATH" \
  '{data: $data} + (if $projectPath != "" then {projectPath: $projectPath} else {} end)')

# POST to the data API
api_call POST "/v2/data/sinks/${SINK_ID}" "$BODY"
