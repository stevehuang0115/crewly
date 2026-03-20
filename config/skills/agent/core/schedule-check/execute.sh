#!/bin/bash
# Schedule a future check-in reminder for yourself (#233, #237)
# Supports time-based frequency for market hours vs off-hours
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"minutes\":20,\"message\":\"Run supervision\",\"recurring\":true}'
  Time-based: '{\"message\":\"Supervise\",\"recurring\":true,\"marketHoursMinutes\":5,\"offHoursMinutes\":20,\"marketHours\":\"09:30-11:30,13:00-15:00\",\"timezone\":\"Asia/Shanghai\"}'"

MINUTES=$(echo "$INPUT" | jq -r '.minutes // empty')
MESSAGE=$(echo "$INPUT" | jq -r '.message // empty')
RECURRING=$(echo "$INPUT" | jq -r '.recurring // false')
MAX_OCCURRENCES=$(echo "$INPUT" | jq -r '.maxOccurrences // empty')

# #237: Time-based frequency parameters
MARKET_HOURS_MIN=$(echo "$INPUT" | jq -r '.marketHoursMinutes // empty')
OFF_HOURS_MIN=$(echo "$INPUT" | jq -r '.offHoursMinutes // empty')
MARKET_HOURS=$(echo "$INPUT" | jq -r '.marketHours // empty')
TIMEZONE=$(echo "$INPUT" | jq -r '.timezone // empty')

require_param "message" "$MESSAGE"

# Default target to the calling agent's own session
TARGET_SESSION="${CREWLY_SESSION_NAME:-}"
[ -z "$TARGET_SESSION" ] && error_exit "CREWLY_SESSION_NAME not set — cannot determine target session"

# #237: If time-based frequency is specified, calculate effective interval
if [ -n "$MARKET_HOURS_MIN" ] && [ -n "$OFF_HOURS_MIN" ]; then
  MARKET_HOURS="${MARKET_HOURS:-09:30-11:30,13:00-15:00}"
  TIMEZONE="${TIMEZONE:-Asia/Shanghai}"

  CURRENT_TIME=$(TZ="$TIMEZONE" date +%H:%M 2>/dev/null || date +%H:%M)
  CURRENT_MINS=$((10#${CURRENT_TIME%%:*} * 60 + 10#${CURRENT_TIME##*:}))

  IS_MARKET=false
  IFS=',' read -ra RANGES <<< "$MARKET_HOURS"
  for range in "${RANGES[@]}"; do
    START_TIME="${range%%-*}"
    END_TIME="${range##*-}"
    START_MINS=$((10#${START_TIME%%:*} * 60 + 10#${START_TIME##*:}))
    END_MINS=$((10#${END_TIME%%:*} * 60 + 10#${END_TIME##*:}))
    if [ "$CURRENT_MINS" -ge "$START_MINS" ] && [ "$CURRENT_MINS" -lt "$END_MINS" ]; then
      IS_MARKET=true
      break
    fi
  done

  if [ "$IS_MARKET" = true ]; then
    MINUTES="$MARKET_HOURS_MIN"
  else
    MINUTES="$OFF_HOURS_MIN"
  fi

  RECURRING="true"
fi

require_param "minutes" "$MINUTES"

if [ "$RECURRING" = "true" ]; then
  BODY=$(jq -n --arg target "$TARGET_SESSION" --arg minutes "$MINUTES" --arg message "$MESSAGE" \
    '{targetSession: $target, minutes: ($minutes | tonumber), intervalMinutes: ($minutes | tonumber), message: $message, isRecurring: true}')
  if [ -n "$MAX_OCCURRENCES" ]; then
    BODY=$(echo "$BODY" | jq --arg max "$MAX_OCCURRENCES" '. + {maxOccurrences: ($max | tonumber)}')
  fi
else
  BODY=$(jq -n --arg target "$TARGET_SESSION" --arg minutes "$MINUTES" --arg message "$MESSAGE" \
    '{targetSession: $target, minutes: ($minutes | tonumber), message: $message}')
fi

api_call POST "/schedule" "$BODY"
