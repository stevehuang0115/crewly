#!/bin/bash
# Copy the App records a wiki vault lists (record-sources.json) into its entity pages now
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && INPUT='{}'
VAULT=$(printf '%s' "$INPUT" | jq -r '.vaultPath // empty')

if [ -n "$VAULT" ]; then
  BODY=$(jq -n --arg v "$VAULT" '{vaultPath: $v}')
else
  BODY='{}'
fi
api_call POST "/wiki/record-sync" "$BODY"
