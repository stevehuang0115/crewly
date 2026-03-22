#!/bin/bash
# Weekly Marketing Report — reads calendar data and generates a structured performance report
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"projectPath\":\"/path\",\"weekEndDate\":\"YYYY-MM-DD\",\"businessName\":\"...\"}'"

# Parse parameters
PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
WEEK_END=$(echo "$INPUT" | jq -r '.weekEndDate // empty')
BUSINESS_NAME=$(echo "$INPUT" | jq -r '.businessName // empty')
CALENDAR_PATH=$(echo "$INPUT" | jq -r '.calendarPath // empty')

require_param "weekEndDate" "$WEEK_END"
require_param "businessName" "$BUSINESS_NAME"

# Determine calendar path
if [ -z "$CALENDAR_PATH" ]; then
  if [ -n "$PROJECT_PATH" ]; then
    CALENDAR_PATH="${PROJECT_PATH}/.crewly/content/calendar.json"
  else
    CALENDAR_PATH="${HOME}/.crewly/content/calendar.json"
  fi
fi

# Check if calendar file exists
if [ ! -f "$CALENDAR_PATH" ]; then
  # Return empty report if no calendar data
  jq -n \
    --arg businessName "$BUSINESS_NAME" \
    --arg weekEnd "$WEEK_END" \
    '{
      "success": true,
      "report": {
        "businessName": $businessName,
        "weekEndDate": $weekEnd,
        "summary": "No content calendar data found. Start by creating a weekly content plan.",
        "totalPosts": 0,
        "platformBreakdown": {},
        "statusBreakdown": {},
        "completionRate": 0,
        "topPerformers": [],
        "recommendations": ["Set up a content calendar using the weekly-content-planning skill.", "Define target platforms and content mix ratios.", "Establish baseline metrics for future comparison."]
      },
      "markdown": "# Weekly Marketing Report — Week ending '"$WEEK_END"'\n\n## Summary\nNo content calendar data found. Start by creating a weekly content plan.\n\n## Recommendations\n1. Set up a content calendar using the weekly-content-planning skill.\n2. Define target platforms and content mix ratios.\n3. Establish baseline metrics for future comparison."
    }'
  exit 0
fi

# Validate calendar JSON
if ! jq empty "$CALENDAR_PATH" 2>/dev/null; then
  error_exit "Calendar file is not valid JSON: $CALENDAR_PATH"
fi

# Calculate week start (6 days before week end = 7-day window)
if date -v-6d +%Y-%m-%d 2>/dev/null >/dev/null; then
  # macOS: -v flag must come before -f
  WEEK_START=$(date -j -v-6d -f "%Y-%m-%d" "$WEEK_END" +%Y-%m-%d 2>/dev/null || echo "$WEEK_END")
else
  # GNU/Linux date
  WEEK_START=$(date -d "$WEEK_END - 6 days" +%Y-%m-%d 2>/dev/null || echo "$WEEK_END")
fi

# Filter entries for this week
WEEK_ENTRIES=$(jq --arg from "$WEEK_START" --arg to "$WEEK_END" \
  '[.entries[] | select(.scheduledDate >= $from and .scheduledDate <= $to)]' \
  "$CALENDAR_PATH")

TOTAL_POSTS=$(echo "$WEEK_ENTRIES" | jq 'length')

# Posts by platform
BY_PLATFORM=$(echo "$WEEK_ENTRIES" | jq '[.[] | .platform] | group_by(.) | map({(.[0]): length}) | add // {}')

# Posts by status
BY_STATUS=$(echo "$WEEK_ENTRIES" | jq '[.[] | .status] | group_by(.) | map({(.[0]): length}) | add // {}')

# Completion rate (published / total)
PUBLISHED_COUNT=$(echo "$WEEK_ENTRIES" | jq '[.[] | select(.status == "published")] | length')
if [ "$TOTAL_POSTS" -gt 0 ]; then
  COMPLETION_RATE=$(( (PUBLISHED_COUNT * 100) / TOTAL_POSTS ))
else
  COMPLETION_RATE=0
fi

# Posts by content type
BY_TYPE=$(echo "$WEEK_ENTRIES" | jq '[.[] | .type] | group_by(.) | map({(.[0]): length}) | add // {}')

# Draft/ready/approved breakdown for pipeline health
DRAFT_COUNT=$(echo "$WEEK_ENTRIES" | jq '[.[] | select(.status == "draft")] | length')
READY_COUNT=$(echo "$WEEK_ENTRIES" | jq '[.[] | select(.status == "ready")] | length')
APPROVED_COUNT=$(echo "$WEEK_ENTRIES" | jq '[.[] | select(.status == "approved")] | length')

# Top performers — published entries (most recently published)
TOP_PERFORMERS=$(echo "$WEEK_ENTRIES" | jq '[.[] | select(.status == "published")] | sort_by(.publishedAt) | reverse | .[:3] | [.[] | {title: .title, platform: .platform, type: .type, scheduledDate: .scheduledDate}]')

# Generate recommendations
RECOMMENDATIONS="[]"

if [ "$TOTAL_POSTS" -eq 0 ]; then
  RECOMMENDATIONS=$(echo "$RECOMMENDATIONS" | jq '. += ["No posts scheduled this week. Create a content plan using the weekly-content-planning skill."]')
elif [ "$TOTAL_POSTS" -lt 5 ]; then
  RECOMMENDATIONS=$(echo "$RECOMMENDATIONS" | jq --argjson count "$TOTAL_POSTS" '. += ["Only \($count) posts scheduled. Target 5-7 posts per week for consistent presence."]')
fi

if [ "$DRAFT_COUNT" -gt 0 ]; then
  RECOMMENDATIONS=$(echo "$RECOMMENDATIONS" | jq --argjson count "$DRAFT_COUNT" '. += ["\($count) posts still in draft. Prioritize moving them to ready status."]')
fi

if [ "$COMPLETION_RATE" -lt 50 ] && [ "$TOTAL_POSTS" -gt 0 ]; then
  RECOMMENDATIONS=$(echo "$RECOMMENDATIONS" | jq --argjson rate "$COMPLETION_RATE" '. += ["Completion rate is \($rate)%. Investigate bottlenecks in the content pipeline."]')
fi

PLATFORM_COUNT=$(echo "$BY_PLATFORM" | jq 'keys | length')
if [ "$PLATFORM_COUNT" -le 1 ] && [ "$TOTAL_POSTS" -gt 0 ]; then
  RECOMMENDATIONS=$(echo "$RECOMMENDATIONS" | jq '. += ["Content concentrated on single platform. Diversify across 2-3 platforms for wider reach."]')
fi

# If no specific recommendations, add general ones
REC_COUNT=$(echo "$RECOMMENDATIONS" | jq 'length')
if [ "$REC_COUNT" -eq 0 ]; then
  RECOMMENDATIONS='["Continue current posting cadence — metrics are on track.", "Experiment with one new content format next week.", "Review engagement data to identify top-performing content themes."]'
fi

# Build markdown report
MARKDOWN="# Weekly Marketing Report — ${BUSINESS_NAME}\n"
MARKDOWN="${MARKDOWN}## Week of ${WEEK_START} to ${WEEK_END}\n\n"
MARKDOWN="${MARKDOWN}## Executive Summary\n"
MARKDOWN="${MARKDOWN}Total posts scheduled: ${TOTAL_POSTS} | Published: ${PUBLISHED_COUNT} | Completion rate: ${COMPLETION_RATE}%\n\n"
MARKDOWN="${MARKDOWN}## Platform Breakdown\n"
MARKDOWN="${MARKDOWN}$(echo "$BY_PLATFORM" | jq -r 'to_entries | .[] | "- **\(.key)**: \(.value) posts"')\n\n"
MARKDOWN="${MARKDOWN}## Status Breakdown\n"
MARKDOWN="${MARKDOWN}$(echo "$BY_STATUS" | jq -r 'to_entries | .[] | "- **\(.key)**: \(.value)"')\n\n"
MARKDOWN="${MARKDOWN}## Pipeline Health\n"
MARKDOWN="${MARKDOWN}| Stage | Count |\n|-------|-------|\n"
MARKDOWN="${MARKDOWN}| Draft | ${DRAFT_COUNT} |\n"
MARKDOWN="${MARKDOWN}| Ready | ${READY_COUNT} |\n"
MARKDOWN="${MARKDOWN}| Approved | ${APPROVED_COUNT} |\n"
MARKDOWN="${MARKDOWN}| Published | ${PUBLISHED_COUNT} |\n\n"

if [ "$(echo "$TOP_PERFORMERS" | jq 'length')" -gt 0 ]; then
  MARKDOWN="${MARKDOWN}## Top Performers\n"
  MARKDOWN="${MARKDOWN}$(echo "$TOP_PERFORMERS" | jq -r '.[] | "- **\(.title)** — \(.platform) (\(.type))"')\n\n"
fi

MARKDOWN="${MARKDOWN}## Recommendations\n"
MARKDOWN="${MARKDOWN}$(echo "$RECOMMENDATIONS" | jq -r 'to_entries | .[] | "\(.key + 1). \(.value)"')\n"

# Build structured report JSON
jq -n \
  --arg businessName "$BUSINESS_NAME" \
  --arg weekStart "$WEEK_START" \
  --arg weekEnd "$WEEK_END" \
  --argjson totalPosts "$TOTAL_POSTS" \
  --argjson publishedCount "$PUBLISHED_COUNT" \
  --argjson completionRate "$COMPLETION_RATE" \
  --argjson platformBreakdown "$BY_PLATFORM" \
  --argjson statusBreakdown "$BY_STATUS" \
  --argjson typeBreakdown "$BY_TYPE" \
  --argjson topPerformers "$TOP_PERFORMERS" \
  --argjson recommendations "$RECOMMENDATIONS" \
  --argjson draftCount "$DRAFT_COUNT" \
  --argjson readyCount "$READY_COUNT" \
  --argjson approvedCount "$APPROVED_COUNT" \
  --arg markdown "$(echo -e "$MARKDOWN")" \
  '{
    "success": true,
    "report": {
      "businessName": $businessName,
      "weekStartDate": $weekStart,
      "weekEndDate": $weekEnd,
      "summary": "Total: \($totalPosts) posts | Published: \($publishedCount) | Completion: \($completionRate)%",
      "totalPosts": $totalPosts,
      "publishedCount": $publishedCount,
      "completionRate": $completionRate,
      "platformBreakdown": $platformBreakdown,
      "statusBreakdown": $statusBreakdown,
      "typeBreakdown": $typeBreakdown,
      "pipelineHealth": {
        "draft": $draftCount,
        "ready": $readyCount,
        "approved": $approvedCount,
        "published": $publishedCount
      },
      "topPerformers": $topPerformers,
      "recommendations": $recommendations
    },
    "markdown": $markdown
  }'
