#!/bin/bash
# Eval skill logging helper — prepended to each skill shim.
# Writes a structured JSONL record to .crewly/.tool-log.jsonl
# so the eval framework can reconstruct tool call history.
#
# Usage (called internally by skill shims):
#   source "$(dirname "$0")/_log.sh"
#   log_tool_call "$SKILL_NAME" "$1"

EVAL_LOG_DIR="$(pwd)/.crewly"
EVAL_LOG_FILE="${EVAL_LOG_DIR}/.tool-log.jsonl"

log_tool_call() {
  local tool_name="$1"
  local args="$2"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$EVAL_LOG_DIR"

  # Ensure args is valid JSON; fallback to string wrapper
  if ! echo "$args" | jq empty 2>/dev/null; then
    args=$(jq -n --arg a "$args" '{"raw": $a}')
  fi

  jq -cn \
    --arg tool "$tool_name" \
    --argjson args "$args" \
    --arg ts "$timestamp" \
    '{"tool": $tool, "args": $args, "timestamp": $ts}' \
    >> "$EVAL_LOG_FILE"
}
