#!/bin/bash
# Weekly Content Planning — generates a weekly content calendar with 5-7 posts
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"businessName\":\"...\",\"industry\":\"...\",\"platforms\":[\"x\",\"linkedin\"],\"weekStartDate\":\"YYYY-MM-DD\"}'"

# Parse parameters
BUSINESS_NAME=$(echo "$INPUT" | jq -r '.businessName // empty')
INDUSTRY=$(echo "$INPUT" | jq -r '.industry // empty')
PLATFORMS=$(echo "$INPUT" | jq -r '.platforms // empty')
CONTENT_MIX=$(echo "$INPUT" | jq -r '.contentMix // "{\"educational\":40,\"engagement\":30,\"promotional\":20,\"community\":10}"')
WEEK_START=$(echo "$INPUT" | jq -r '.weekStartDate // empty')
PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
POST_COUNT=$(echo "$INPUT" | jq -r '.postCount // "5"')

require_param "businessName" "$BUSINESS_NAME"
require_param "industry" "$INDUSTRY"
require_param "platforms" "$PLATFORMS"
require_param "weekStartDate" "$WEEK_START"

# Validate platforms is a JSON array
if ! echo "$PLATFORMS" | jq -e 'type == "array"' >/dev/null 2>&1; then
  error_exit "platforms must be a JSON array, e.g. [\"x\",\"linkedin\"]"
fi

PLATFORM_COUNT=$(echo "$PLATFORMS" | jq 'length')
if [ "$PLATFORM_COUNT" -eq 0 ]; then
  error_exit "platforms array must not be empty"
fi

# Validate content mix
if ! echo "$CONTENT_MIX" | jq empty 2>/dev/null; then
  CONTENT_MIX='{"educational":40,"engagement":30,"promotional":20,"community":10}'
fi

# Path to content-calendar skill
CALENDAR_SKILL="${SCRIPT_DIR}/../../content-calendar/execute.sh"
if [ ! -f "$CALENDAR_SKILL" ]; then
  error_exit "content-calendar skill not found at ${CALENDAR_SKILL}"
fi

# Helper: get topic by category
get_topic() {
  local cat="$1"
  case "$cat" in
    educational) echo "Industry insight: ${INDUSTRY} trends and best practices" ;;
    engagement) echo "Community question: What matters most to our ${INDUSTRY} audience" ;;
    promotional) echo "Product spotlight: How ${BUSINESS_NAME} solves ${INDUSTRY} challenges" ;;
    community) echo "Behind the scenes: A day at ${BUSINESS_NAME}" ;;
    *) echo "Content for ${BUSINESS_NAME}" ;;
  esac
}

# Compute content mix distribution
EDU_PCT=$(echo "$CONTENT_MIX" | jq -r '.educational // 40')
ENG_PCT=$(echo "$CONTENT_MIX" | jq -r '.engagement // 30')
PROMO_PCT=$(echo "$CONTENT_MIX" | jq -r '.promotional // 20')
COMM_PCT=$(echo "$CONTENT_MIX" | jq -r '.community // 10')

# Calculate post count per category
TOTAL_PCT=$((EDU_PCT + ENG_PCT + PROMO_PCT + COMM_PCT))
if [ "$TOTAL_PCT" -eq 0 ]; then
  TOTAL_PCT=100
fi

EDU_COUNT=$(( (POST_COUNT * EDU_PCT + TOTAL_PCT - 1) / TOTAL_PCT ))
ENG_COUNT=$(( (POST_COUNT * ENG_PCT + TOTAL_PCT - 1) / TOTAL_PCT ))
PROMO_COUNT=$(( (POST_COUNT * PROMO_PCT + TOTAL_PCT - 1) / TOTAL_PCT ))
COMM_COUNT=$(( POST_COUNT - EDU_COUNT - ENG_COUNT - PROMO_COUNT ))
[ "$COMM_COUNT" -lt 0 ] && COMM_COUNT=0

# Build ordered category list as space-separated string
CATEGORIES=""
i=0; while [ "$i" -lt "$EDU_COUNT" ]; do CATEGORIES="$CATEGORIES educational"; i=$((i+1)); done
i=0; while [ "$i" -lt "$ENG_COUNT" ]; do CATEGORIES="$CATEGORIES engagement"; i=$((i+1)); done
i=0; while [ "$i" -lt "$PROMO_COUNT" ]; do CATEGORIES="$CATEGORIES promotional"; i=$((i+1)); done
i=0; while [ "$i" -lt "$COMM_COUNT" ]; do CATEGORIES="$CATEGORIES community"; i=$((i+1)); done

# Trim whitespace and convert to array-like processing
CATEGORIES=$(echo "$CATEGORIES" | xargs)

# Trim to POST_COUNT
CAT_ARRAY=""
COUNT=0
for CAT in $CATEGORIES; do
  if [ "$COUNT" -ge "$POST_COUNT" ]; then break; fi
  CAT_ARRAY="$CAT_ARRAY $CAT"
  COUNT=$((COUNT + 1))
done
CAT_ARRAY=$(echo "$CAT_ARRAY" | xargs)
TOTAL_ENTRIES=$COUNT

DAY_NAMES="Mon Tue Wed Thu Fri Sat Sun"

# Generate entries
ENTRIES="[]"
MARKDOWN_TABLE="| Day | Platform | Type | Category | Topic | Status |\n|-----|----------|------|----------|-------|--------|\n"

INDEX=0
for CATEGORY in $CAT_ARRAY; do
  # Cycle through platforms
  PLATFORM_INDEX=$((INDEX % PLATFORM_COUNT))
  PLATFORM_RAW=$(echo "$PLATFORMS" | jq -r ".[$PLATFORM_INDEX]")

  # Normalize platform display names to calendar skill identifiers
  case "$(echo "$PLATFORM_RAW" | tr '[:upper:]' '[:lower:]')" in
    "x (twitter)"|"x"|"twitter") PLATFORM="x" ;;
    "linkedin")                  PLATFORM="linkedin" ;;
    "instagram")                 PLATFORM="instagram" ;;
    "facebook")                  PLATFORM="facebook" ;;
    "youtube")                   PLATFORM="youtube" ;;
    "xiaohongshu"|"小红书")       PLATFORM="xiaohongshu" ;;
    "substack")                  PLATFORM="substack" ;;
    "reddit")                    PLATFORM="reddit" ;;
    "github")                    PLATFORM="github" ;;
    *) PLATFORM=$(echo "$PLATFORM_RAW" | tr '[:upper:]' '[:lower:]') ;;
  esac

  # Calculate the date offset (spread across the week)
  DAY_OFFSET=$((INDEX * 7 / TOTAL_ENTRIES))

  # Calculate scheduled date
  if date -v+${DAY_OFFSET}d +%Y-%m-%d 2>/dev/null >/dev/null; then
    # macOS: -v flag must come before -f
    SCHED_DATE=$(date -j -v+${DAY_OFFSET}d -f "%Y-%m-%d" "$WEEK_START" +%Y-%m-%d 2>/dev/null || echo "$WEEK_START")
  else
    # GNU date
    SCHED_DATE=$(date -d "$WEEK_START + $DAY_OFFSET days" +%Y-%m-%d 2>/dev/null || echo "$WEEK_START")
  fi

  # Set content type based on platform
  case "$PLATFORM" in
    x) CONTENT_TYPE="post" ;;
    linkedin) CONTENT_TYPE="post" ;;
    instagram) CONTENT_TYPE="image-text" ;;
    youtube) CONTENT_TYPE="video" ;;
    substack) CONTENT_TYPE="newsletter" ;;
    *) CONTENT_TYPE="post" ;;
  esac

  TOPIC=$(get_topic "$CATEGORY")
  TITLE="${BUSINESS_NAME} — ${CATEGORY} content for ${PLATFORM} (Week of ${WEEK_START})"

  # Get day name from offset
  DAY_NAME=$(echo "$DAY_NAMES" | cut -d' ' -f$((DAY_OFFSET + 1)))

  # Add to content calendar via skill
  ADD_INPUT=$(jq -n \
    --arg action "add" \
    --arg title "$TITLE" \
    --arg platform "$PLATFORM" \
    --arg type "$CONTENT_TYPE" \
    --arg scheduledDate "$SCHED_DATE" \
    --arg status "draft" \
    --arg topic "$TOPIC" \
    --arg notes "Category: ${CATEGORY}. Auto-generated by weekly-content-planning skill." \
    --arg projectPath "$PROJECT_PATH" \
    '{action:$action,title:$title,platform:$platform,type:$type,scheduledDate:$scheduledDate,status:$status,topic:$topic,notes:$notes,projectPath:$projectPath}')

  RESULT=$(bash "$CALENDAR_SKILL" "$ADD_INPUT" 2>/dev/null || echo '{"success":false}')

  ENTRY_ID=$(echo "$RESULT" | jq -r '.entry.id // "unknown"')

  # Build entry object
  ENTRY=$(jq -n \
    --arg id "$ENTRY_ID" \
    --arg day "$DAY_NAME" \
    --arg platform "$PLATFORM" \
    --arg type "$CONTENT_TYPE" \
    --arg category "$CATEGORY" \
    --arg topic "$TOPIC" \
    --arg title "$TITLE" \
    --arg scheduledDate "$SCHED_DATE" \
    --arg status "draft" \
    '{id:$id,day:$day,platform:$platform,type:$type,category:$category,topic:$topic,title:$title,scheduledDate:$scheduledDate,status:$status}')

  ENTRIES=$(echo "$ENTRIES" | jq --argjson e "$ENTRY" '. += [$e]')
  MARKDOWN_TABLE="${MARKDOWN_TABLE}| ${DAY_NAME} | ${PLATFORM} | ${CONTENT_TYPE} | ${CATEGORY} | ${TOPIC} | draft |\n"

  INDEX=$((INDEX + 1))
done

ENTRY_COUNT=$(echo "$ENTRIES" | jq 'length')

# Output result
jq -n \
  --arg businessName "$BUSINESS_NAME" \
  --arg weekStart "$WEEK_START" \
  --argjson entries "$ENTRIES" \
  --argjson entryCount "$ENTRY_COUNT" \
  --arg calendar "$(echo -e "$MARKDOWN_TABLE")" \
  '{
    "success": true,
    "businessName": $businessName,
    "weekStartDate": $weekStart,
    "entryCount": $entryCount,
    "entries": $entries,
    "calendar": $calendar
  }'
