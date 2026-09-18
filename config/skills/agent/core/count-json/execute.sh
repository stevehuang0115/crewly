#!/bin/bash
# count-json — run a command (or read a file) that yields JSON, count entries
# matching field=value. Output: {"count":N,"total":M,"filter":"field=value"}
#
# Usage: execute.sh '{"command":"...","field":"status","value":"review"}'
#        execute.sh '{"file":"/tmp/board.json","field":"status","value":"open"}'
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"command\":\"...\",\"field\":\"status\",\"value\":\"review\"}'"

COMMAND=$(printf '%s' "$INPUT" | jq -r '.command // empty')
FILE=$(printf '%s' "$INPUT" | jq -r '.file // empty')
FIELD=$(printf '%s' "$INPUT" | jq -r '.field // empty')
VALUE=$(printf '%s' "$INPUT" | jq -r '.value // empty')
ARRAY_PATH=$(printf '%s' "$INPUT" | jq -r '.arrayPath // empty')
TIMEOUT_S="${COUNT_JSON_TIMEOUT_S:-50}"

[ -z "$COMMAND" ] && [ -z "$FILE" ] && error_exit "command or file is required"

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || error_exit "file not found: $FILE"
  RAW=$(cat "$FILE")
else
  if command -v timeout >/dev/null 2>&1; then
    RAW=$(timeout "$TIMEOUT_S" bash -c "$COMMAND" 2>/dev/null)
  else
    RAW=$(bash -c "$COMMAND" 2>/dev/null)
  fi
  [ $? -ne 0 ] && [ -z "$RAW" ] && error_exit "command failed or produced no output"
fi

# Skip any non-JSON preamble (progress lines, banners).
JSON=$(printf '%s' "$RAW" | awk 'found||/^[[{]/{found=1; print}')
[ -z "$JSON" ] && error_exit "no JSON found in output"

if [ -n "$ARRAY_PATH" ]; then
  SELECT="$ARRAY_PATH"
else
  SELECT='if type=="array" then . elif (.items|type)=="array" then .items elif (.tickets|type)=="array" then .tickets elif (.data|type)=="array" then .data else [] end'
fi

if [ -n "$FIELD" ]; then
  printf '%s' "$JSON" | jq -c --arg f "$FIELD" --arg v "$VALUE" \
    "($SELECT) as \$arr | {count: (\$arr | map(select((.[\$f] // \"\" | tostring) == \$v)) | length), total: (\$arr | length), filter: (\$f + \"=\" + \$v)}" \
    || error_exit "output is not valid JSON"
else
  printf '%s' "$JSON" | jq -c "($SELECT) as \$arr | {count: (\$arr | length), total: (\$arr | length), filter: \"\"}" \
    || error_exit "output is not valid JSON"
fi
