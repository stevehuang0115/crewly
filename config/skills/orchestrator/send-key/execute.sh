#!/bin/bash
# Send a key or key sequence to an agent's terminal session
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"sessionName\":\"agent-session\",\"key\":\"Enter\"}' or '{\"sessionName\":\"...\",\"keys\":[\"Down\",\"Down\",\"Enter\"]}'"

SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
KEY=$(printf '%s' "$INPUT" | jq -r '.key // empty')
KEYS=$(printf '%s' "$INPUT" | jq -r '.keys // empty')
require_param "sessionName" "$SESSION_NAME"

# Support both single key and key sequence
if [ -n "$KEY" ]; then
  BODY=$(jq -n --arg key "$KEY" '{key: $key}')
  api_call POST "/terminal/${SESSION_NAME}/key" "$BODY"
elif [ "$KEYS" != "" ] && [ "$KEYS" != "null" ]; then
  KEY_COUNT=$(printf '%s' "$INPUT" | jq '.keys | length')
  for (( i=0; i<KEY_COUNT; i++ )); do
    CURRENT_KEY=$(printf '%s' "$INPUT" | jq -r ".keys[$i]")
    BODY=$(jq -n --arg key "$CURRENT_KEY" '{key: $key}')
    api_call POST "/terminal/${SESSION_NAME}/key" "$BODY"
    # Small delay between keys to allow processing
    [ "$i" -lt "$((KEY_COUNT - 1))" ] && sleep 0.3
  done
else
  error_exit "Either 'key' (single) or 'keys' (array) parameter is required"
fi
