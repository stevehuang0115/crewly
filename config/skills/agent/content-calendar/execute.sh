#!/bin/bash
# Content Calendar Manager — CRUD operations for content scheduling
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"add|list|update|next|stats\",\"calendarPath\":\"/path/to/calendar.json\",...}'"

# Parse common parameters
ACTION=$(echo "$INPUT" | jq -r '.action // empty')
CALENDAR_PATH=$(echo "$INPUT" | jq -r '.calendarPath // empty')

require_param "action" "$ACTION"

# Default calendar path
if [ -z "$CALENDAR_PATH" ]; then
  # Try to find project .crewly directory
  PROJECT_PATH=$(echo "$INPUT" | jq -r '.projectPath // empty')
  if [ -n "$PROJECT_PATH" ]; then
    CALENDAR_PATH="${PROJECT_PATH}/.crewly/content/calendar.json"
  else
    CALENDAR_PATH="${HOME}/.crewly/content/calendar.json"
  fi
fi

# Ensure calendar directory and file exist
CALENDAR_DIR=$(dirname "$CALENDAR_PATH")
mkdir -p "$CALENDAR_DIR"
if [ ! -f "$CALENDAR_PATH" ]; then
  echo '{"entries":[],"metadata":{"createdAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","version":"1.0"}}' > "$CALENDAR_PATH"
fi

# Validate calendar JSON
if ! jq empty "$CALENDAR_PATH" 2>/dev/null; then
  error_exit "Calendar file is not valid JSON: $CALENDAR_PATH"
fi

case "$ACTION" in

  # ─────────────────────────────────────────────
  # ADD: Add a new content entry
  # ─────────────────────────────────────────────
  add)
    TITLE=$(echo "$INPUT" | jq -r '.title // empty')
    PLATFORM=$(echo "$INPUT" | jq -r '.platform // empty')
    CONTENT_TYPE=$(echo "$INPUT" | jq -r '.type // "post"')
    SCHEDULED_DATE=$(echo "$INPUT" | jq -r '.scheduledDate // empty')
    STATUS=$(echo "$INPUT" | jq -r '.status // "draft"')
    CONTENT_PATH=$(echo "$INPUT" | jq -r '.contentPath // empty')
    LINE=$(echo "$INPUT" | jq -r '.line // "crewly"')
    TOPIC=$(echo "$INPUT" | jq -r '.topic // empty')
    NOTES=$(echo "$INPUT" | jq -r '.notes // empty')
    TAGS=$(echo "$INPUT" | jq -r '.tags // "[]"')

    require_param "title" "$TITLE"
    require_param "platform" "$PLATFORM"
    require_param "scheduledDate" "$SCHEDULED_DATE"

    # Validate platform
    VALID_PLATFORMS="x|linkedin|xiaohongshu|substack|youtube|github|reddit|instagram|facebook"
    if ! echo "$PLATFORM" | grep -qE "^(${VALID_PLATFORMS})$"; then
      error_exit "Invalid platform: $PLATFORM. Valid: x, linkedin, instagram, facebook, xiaohongshu, substack, youtube, github, reddit"
    fi

    # Validate status
    VALID_STATUSES="idea|draft|ready|in-review|approved|published|archived"
    if ! echo "$STATUS" | grep -qE "^(${VALID_STATUSES})$"; then
      error_exit "Invalid status: $STATUS. Valid: idea, draft, ready, in-review, approved, published, archived"
    fi

    # Validate content type
    VALID_TYPES="post|thread|article|video|image-text|newsletter|showcase|tutorial"
    if ! echo "$CONTENT_TYPE" | grep -qE "^(${VALID_TYPES})$"; then
      error_exit "Invalid type: $CONTENT_TYPE. Valid: post, thread, article, video, image-text, newsletter, showcase, tutorial"
    fi

    # Generate entry ID (timestamp-based)
    ENTRY_ID="cc-$(date +%s)-$((RANDOM % 1000))"
    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Ensure tags is valid JSON array
    if ! echo "$TAGS" | jq empty 2>/dev/null; then
      TAGS="[]"
    fi

    # Build new entry
    NEW_ENTRY=$(jq -n \
      --arg id "$ENTRY_ID" \
      --arg title "$TITLE" \
      --arg platform "$PLATFORM" \
      --arg type "$CONTENT_TYPE" \
      --arg scheduledDate "$SCHEDULED_DATE" \
      --arg status "$STATUS" \
      --arg contentPath "$CONTENT_PATH" \
      --arg line "$LINE" \
      --arg topic "$TOPIC" \
      --arg notes "$NOTES" \
      --argjson tags "$TAGS" \
      --arg createdAt "$NOW" \
      --arg updatedAt "$NOW" \
      '{
        id: $id,
        title: $title,
        platform: $platform,
        type: $type,
        scheduledDate: $scheduledDate,
        status: $status,
        contentPath: $contentPath,
        line: $line,
        topic: $topic,
        notes: $notes,
        tags: $tags,
        createdAt: $createdAt,
        updatedAt: $updatedAt
      }')

    # Append to calendar
    jq --argjson entry "$NEW_ENTRY" '.entries += [$entry]' "$CALENDAR_PATH" > "${CALENDAR_PATH}.tmp" \
      && mv "${CALENDAR_PATH}.tmp" "$CALENDAR_PATH"

    jq -n --argjson entry "$NEW_ENTRY" '{"success":true,"action":"add","entry":$entry}'
    ;;

  # ─────────────────────────────────────────────
  # LIST: List calendar entries with filters
  # ─────────────────────────────────────────────
  list)
    FILTER_PLATFORM=$(echo "$INPUT" | jq -r '.platform // empty')
    FILTER_STATUS=$(echo "$INPUT" | jq -r '.status // empty')
    FILTER_DATE=$(echo "$INPUT" | jq -r '.date // empty')
    FILTER_DATE_FROM=$(echo "$INPUT" | jq -r '.dateFrom // empty')
    FILTER_DATE_TO=$(echo "$INPUT" | jq -r '.dateTo // empty')
    FILTER_LINE=$(echo "$INPUT" | jq -r '.line // empty')
    LIMIT=$(echo "$INPUT" | jq -r '.limit // "50"')

    # Build jq filter
    JQ_FILTER=".entries"

    if [ -n "$FILTER_PLATFORM" ]; then
      JQ_FILTER="${JQ_FILTER} | map(select(.platform == \"${FILTER_PLATFORM}\"))"
    fi
    if [ -n "$FILTER_STATUS" ]; then
      JQ_FILTER="${JQ_FILTER} | map(select(.status == \"${FILTER_STATUS}\"))"
    fi
    if [ -n "$FILTER_DATE" ]; then
      JQ_FILTER="${JQ_FILTER} | map(select(.scheduledDate == \"${FILTER_DATE}\"))"
    fi
    if [ -n "$FILTER_DATE_FROM" ]; then
      JQ_FILTER="${JQ_FILTER} | map(select(.scheduledDate >= \"${FILTER_DATE_FROM}\"))"
    fi
    if [ -n "$FILTER_DATE_TO" ]; then
      JQ_FILTER="${JQ_FILTER} | map(select(.scheduledDate <= \"${FILTER_DATE_TO}\"))"
    fi
    if [ -n "$FILTER_LINE" ]; then
      JQ_FILTER="${JQ_FILTER} | map(select(.line == \"${FILTER_LINE}\"))"
    fi

    # Sort by scheduled date and limit
    JQ_FILTER="${JQ_FILTER} | sort_by(.scheduledDate) | .[:${LIMIT}]"

    ENTRIES=$(jq "$JQ_FILTER" "$CALENDAR_PATH")
    COUNT=$(echo "$ENTRIES" | jq 'length')

    jq -n \
      --argjson entries "$ENTRIES" \
      --argjson count "$COUNT" \
      --arg calendarPath "$CALENDAR_PATH" \
      '{"success":true,"action":"list","count":$count,"entries":$entries,"calendarPath":$calendarPath}'
    ;;

  # ─────────────────────────────────────────────
  # UPDATE: Update an existing entry
  # ─────────────────────────────────────────────
  update)
    ENTRY_ID=$(echo "$INPUT" | jq -r '.id // empty')
    require_param "id" "$ENTRY_ID"

    # Check if entry exists
    EXISTS=$(jq --arg id "$ENTRY_ID" '[.entries[] | select(.id == $id)] | length' "$CALENDAR_PATH")
    if [ "$EXISTS" -eq 0 ]; then
      error_exit "Entry not found: $ENTRY_ID"
    fi

    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Build update fields dynamically
    UPDATE_FIELDS=".updatedAt = \"${NOW}\""

    NEW_STATUS=$(echo "$INPUT" | jq -r '.status // empty')
    NEW_TITLE=$(echo "$INPUT" | jq -r '.title // empty')
    NEW_DATE=$(echo "$INPUT" | jq -r '.scheduledDate // empty')
    NEW_CONTENT_PATH=$(echo "$INPUT" | jq -r '.contentPath // empty')
    NEW_NOTES=$(echo "$INPUT" | jq -r '.notes // empty')
    NEW_TOPIC=$(echo "$INPUT" | jq -r '.topic // empty')

    [ -n "$NEW_STATUS" ] && UPDATE_FIELDS="${UPDATE_FIELDS} | .status = \"${NEW_STATUS}\""
    [ -n "$NEW_TITLE" ] && UPDATE_FIELDS="${UPDATE_FIELDS} | .title = \"${NEW_TITLE}\""
    [ -n "$NEW_DATE" ] && UPDATE_FIELDS="${UPDATE_FIELDS} | .scheduledDate = \"${NEW_DATE}\""
    [ -n "$NEW_CONTENT_PATH" ] && UPDATE_FIELDS="${UPDATE_FIELDS} | .contentPath = \"${NEW_CONTENT_PATH}\""
    [ -n "$NEW_NOTES" ] && UPDATE_FIELDS="${UPDATE_FIELDS} | .notes = \"${NEW_NOTES}\""
    [ -n "$NEW_TOPIC" ] && UPDATE_FIELDS="${UPDATE_FIELDS} | .topic = \"${NEW_TOPIC}\""

    # If marking as published, record publishedAt
    if [ "$NEW_STATUS" = "published" ]; then
      UPDATE_FIELDS="${UPDATE_FIELDS} | .publishedAt = \"${NOW}\""
    fi

    # Apply update
    jq --arg id "$ENTRY_ID" \
      "(.entries[] | select(.id == \$id)) |= (${UPDATE_FIELDS})" \
      "$CALENDAR_PATH" > "${CALENDAR_PATH}.tmp" \
      && mv "${CALENDAR_PATH}.tmp" "$CALENDAR_PATH"

    # Return updated entry
    UPDATED=$(jq --arg id "$ENTRY_ID" '.entries[] | select(.id == $id)' "$CALENDAR_PATH")
    jq -n --argjson entry "$UPDATED" '{"success":true,"action":"update","entry":$entry}'
    ;;

  # ─────────────────────────────────────────────
  # NEXT: Get the next content to publish
  # ─────────────────────────────────────────────
  next)
    FILTER_PLATFORM=$(echo "$INPUT" | jq -r '.platform // empty')
    TODAY=$(date -u +%Y-%m-%d)

    # Find entries that are ready/approved and scheduled for today or earlier
    JQ_FILTER='.entries | map(select(.status == "ready" or .status == "approved"))'
    JQ_FILTER="${JQ_FILTER} | map(select(.scheduledDate <= \"${TODAY}\"))"

    if [ -n "$FILTER_PLATFORM" ]; then
      JQ_FILTER="${JQ_FILTER} | map(select(.platform == \"${FILTER_PLATFORM}\"))"
    fi

    JQ_FILTER="${JQ_FILTER} | sort_by(.scheduledDate) | .[0] // null"

    NEXT_ENTRY=$(jq "$JQ_FILTER" "$CALENDAR_PATH")

    if [ "$NEXT_ENTRY" = "null" ]; then
      # Also show upcoming entries
      UPCOMING=$(jq --arg today "$TODAY" \
        '[.entries[] | select(.status == "draft" or .status == "ready" or .status == "approved") | select(.scheduledDate > $today)] | sort_by(.scheduledDate) | .[:3]' \
        "$CALENDAR_PATH")
      jq -n --argjson upcoming "$UPCOMING" \
        '{"success":true,"action":"next","next":null,"message":"No content ready to publish right now.","upcoming":$upcoming}'
    else
      jq -n --argjson entry "$NEXT_ENTRY" \
        '{"success":true,"action":"next","next":$entry}'
    fi
    ;;

  # ─────────────────────────────────────────────
  # STATS: Calendar statistics
  # ─────────────────────────────────────────────
  stats)
    TOTAL=$(jq '.entries | length' "$CALENDAR_PATH")
    BY_STATUS=$(jq '[.entries[] | .status] | group_by(.) | map({(.[0]): length}) | add // {}' "$CALENDAR_PATH")
    BY_PLATFORM=$(jq '[.entries[] | .platform] | group_by(.) | map({(.[0]): length}) | add // {}' "$CALENDAR_PATH")
    BY_LINE=$(jq '[.entries[] | .line] | group_by(.) | map({(.[0]): length}) | add // {}' "$CALENDAR_PATH")

    TODAY=$(date -u +%Y-%m-%d)
    OVERDUE=$(jq --arg today "$TODAY" \
      '[.entries[] | select(.scheduledDate < $today and (.status == "draft" or .status == "ready" or .status == "approved"))] | length' \
      "$CALENDAR_PATH")
    THIS_WEEK_END=$(date -u -v+7d +%Y-%m-%d 2>/dev/null || date -u -d "+7 days" +%Y-%m-%d 2>/dev/null || echo "$TODAY")
    THIS_WEEK=$(jq --arg from "$TODAY" --arg to "$THIS_WEEK_END" \
      '[.entries[] | select(.scheduledDate >= $from and .scheduledDate <= $to)] | length' \
      "$CALENDAR_PATH")

    jq -n \
      --argjson total "$TOTAL" \
      --argjson byStatus "$BY_STATUS" \
      --argjson byPlatform "$BY_PLATFORM" \
      --argjson byLine "$BY_LINE" \
      --argjson overdue "$OVERDUE" \
      --argjson thisWeek "$THIS_WEEK" \
      --arg calendarPath "$CALENDAR_PATH" \
      '{
        "success": true,
        "action": "stats",
        "total": $total,
        "byStatus": $byStatus,
        "byPlatform": $byPlatform,
        "byLine": $byLine,
        "overdue": $overdue,
        "thisWeek": $thisWeek,
        "calendarPath": $calendarPath
      }'
    ;;

  *)
    error_exit "Unknown action: $ACTION. Valid actions: add, list, update, next, stats"
    ;;
esac
