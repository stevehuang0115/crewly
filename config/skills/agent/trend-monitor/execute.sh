#!/bin/bash
# Trend Monitor — save, read, and manage trend data from browser scans
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"save|list|latest|suggest\",\"projectPath\":\"/path/to/project\",...}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

require_param "action" "$ACTION"

# Resolve trends directory
if [ -n "$PROJECT_PATH" ]; then
  TRENDS_DIR="${PROJECT_PATH}/.crewly/content/trends"
else
  TRENDS_DIR="${HOME}/.crewly/content/trends"
fi
mkdir -p "$TRENDS_DIR"

case "$ACTION" in

  # ─────────────────────────────────────────────
  # SAVE: Store a batch of trends from a browser scan
  # ─────────────────────────────────────────────
  save)
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty')
    TRENDS=$(printf '%s' "$INPUT" | jq -r '.trends // empty')

    require_param "source" "$SOURCE"
    require_param "trends" "$TRENDS"

    # Validate source
    case "$SOURCE" in
      x-trending|google-trends|hackernews|producthunt|reddit|github-trending|custom) ;;
      *) error_exit "Invalid source: $SOURCE. Valid: x-trending, google-trends, hackernews, producthunt, reddit, github-trending, custom" ;;
    esac

    # Validate trends is a JSON array
    if ! echo "$TRENDS" | jq 'type == "array"' 2>/dev/null | grep -q true; then
      error_exit "trends must be a JSON array of objects"
    fi

    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    TODAY=$(date -u +%Y-%m-%d)
    SCAN_ID="scan-$(date +%s)-$((RANDOM % 1000))"

    # Add metadata to each trend
    ENRICHED=$(echo "$TRENDS" | jq --arg source "$SOURCE" --arg scanId "$SCAN_ID" --arg ts "$NOW" \
      '[.[] | . + {"source": $source, "scanId": $scanId, "scannedAt": $ts}]')

    # Count items
    COUNT=$(echo "$ENRICHED" | jq 'length')

    # Save to date-based file
    SCAN_FILE="${TRENDS_DIR}/${TODAY}-${SOURCE}.json"

    if [ -f "$SCAN_FILE" ]; then
      # Append to existing file
      EXISTING=$(cat "$SCAN_FILE")
      MERGED=$(jq -n --argjson existing "$EXISTING" --argjson new "$ENRICHED" \
        '{"scans": ($existing.scans + [{"scanId": $new[0].scanId, "scannedAt": $new[0].scannedAt, "count": ($new | length), "items": $new}])}')
      echo "$MERGED" > "$SCAN_FILE"
    else
      # Create new file
      jq -n --argjson items "$ENRICHED" --arg source "$SOURCE" --arg date "$TODAY" \
        '{"source": $source, "date": $date, "scans": [{"scanId": $items[0].scanId, "scannedAt": $items[0].scannedAt, "count": ($items | length), "items": $items}]}' > "$SCAN_FILE"
    fi

    jq -n \
      --arg scanId "$SCAN_ID" \
      --arg source "$SOURCE" \
      --argjson count "$COUNT" \
      --arg file "$SCAN_FILE" \
      --arg scannedAt "$NOW" \
      '{"success":true,"action":"save","scanId":$scanId,"source":$source,"count":$count,"file":$file,"scannedAt":$scannedAt}'
    ;;

  # ─────────────────────────────────────────────
  # LIST: List available trend scans
  # ─────────────────────────────────────────────
  list)
    FILTER_SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty')
    FILTER_DATE=$(printf '%s' "$INPUT" | jq -r '.date // empty')
    LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // "10"')

    FILES="[]"
    for f in "$TRENDS_DIR"/*.json; do
      [ -f "$f" ] || continue
      BASENAME=$(basename "$f" .json)
      FILE_DATE=$(echo "$BASENAME" | cut -d'-' -f1-3)
      FILE_SOURCE=$(echo "$BASENAME" | cut -d'-' -f4-)

      # Apply filters
      if [ -n "$FILTER_SOURCE" ] && [ "$FILE_SOURCE" != "$FILTER_SOURCE" ]; then
        continue
      fi
      if [ -n "$FILTER_DATE" ] && [ "$FILE_DATE" != "$FILTER_DATE" ]; then
        continue
      fi

      SCAN_COUNT=$(jq '.scans | length' "$f" 2>/dev/null || echo "0")
      TOTAL_ITEMS=$(jq '[.scans[].count] | add // 0' "$f" 2>/dev/null || echo "0")
      LAST_SCAN=$(jq -r '.scans[-1].scannedAt // "unknown"' "$f" 2>/dev/null || echo "unknown")

      FILES=$(echo "$FILES" | jq \
        --arg file "$f" \
        --arg date "$FILE_DATE" \
        --arg source "$FILE_SOURCE" \
        --argjson scanCount "$SCAN_COUNT" \
        --argjson totalItems "$TOTAL_ITEMS" \
        --arg lastScan "$LAST_SCAN" \
        '. + [{"file":$file,"date":$date,"source":$source,"scanCount":$scanCount,"totalItems":$totalItems,"lastScan":$lastScan}]')
    done

    # Sort by date descending and limit
    FILES=$(echo "$FILES" | jq --argjson limit "$LIMIT" 'sort_by(.date) | reverse | .[:$limit]')
    COUNT=$(echo "$FILES" | jq 'length')

    jq -n --argjson files "$FILES" --argjson count "$COUNT" \
      '{"success":true,"action":"list","count":$count,"files":$files}'
    ;;

  # ─────────────────────────────────────────────
  # LATEST: Get the latest trends from a specific source
  # ─────────────────────────────────────────────
  latest)
    FILTER_SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty')
    LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // "20"')

    # Find most recent file(s)
    ALL_ITEMS="[]"

    for f in $(ls -t "$TRENDS_DIR"/*.json 2>/dev/null | head -5); do
      [ -f "$f" ] || continue
      FILE_SOURCE=$(basename "$f" .json | cut -d'-' -f4-)

      if [ -n "$FILTER_SOURCE" ] && [ "$FILE_SOURCE" != "$FILTER_SOURCE" ]; then
        continue
      fi

      # Get items from the latest scan in each file
      ITEMS=$(jq '.scans[-1].items // []' "$f" 2>/dev/null || echo "[]")
      ALL_ITEMS=$(jq -n --argjson a "$ALL_ITEMS" --argjson b "$ITEMS" '$a + $b')
    done

    # Sort by relevance score if available, limit
    ALL_ITEMS=$(echo "$ALL_ITEMS" | jq --argjson limit "$LIMIT" \
      'sort_by(.relevanceScore // 0) | reverse | .[:$limit]')
    COUNT=$(echo "$ALL_ITEMS" | jq 'length')

    jq -n --argjson items "$ALL_ITEMS" --argjson count "$COUNT" \
      '{"success":true,"action":"latest","count":$count,"items":$items}'
    ;;

  # ─────────────────────────────────────────────
  # SUGGEST: Generate topic suggestions from recent trends
  # ─────────────────────────────────────────────
  suggest)
    CONTENT_LINE=$(printf '%s' "$INPUT" | jq -r '.line // "crewly"')
    LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // "5"')

    # Gather all recent trend items (last 3 days)
    ALL_ITEMS="[]"
    for f in $(ls -t "$TRENDS_DIR"/*.json 2>/dev/null | head -10); do
      [ -f "$f" ] || continue
      ITEMS=$(jq '.scans[-1].items // []' "$f" 2>/dev/null || echo "[]")
      ALL_ITEMS=$(jq -n --argjson a "$ALL_ITEMS" --argjson b "$ITEMS" '$a + $b')
    done

    COUNT=$(echo "$ALL_ITEMS" | jq 'length')

    if [ "$COUNT" -eq 0 ]; then
      jq -n '{"success":true,"action":"suggest","suggestions":[],"message":"No trend data available. Run a browser scan first using the instructions in instructions.md."}'
      exit 0
    fi

    # Filter for AI-related trends
    AI_ITEMS=$(echo "$ALL_ITEMS" | jq '[.[] | select(
      (.title // "" | test("(?i)ai|agent|llm|gpt|claude|gemini|automation|saas|startup")) or
      (.relevanceScore // 0) >= 7
    )]')

    AI_COUNT=$(echo "$AI_ITEMS" | jq 'length')

    # Build suggestion context
    TOPICS=$(echo "$AI_ITEMS" | jq --argjson limit "$LIMIT" \
      '[.[:$limit] | .[] | {title: .title, source: .source, url: (.url // ""), relevanceScore: (.relevanceScore // 0)}]')

    jq -n \
      --argjson allTrends "$COUNT" \
      --argjson aiRelevant "$AI_COUNT" \
      --argjson topics "$TOPICS" \
      --arg line "$CONTENT_LINE" \
      '{
        "success": true,
        "action": "suggest",
        "totalTrendsScanned": $allTrends,
        "aiRelevantTrends": $aiRelevant,
        "contentLine": $line,
        "suggestedTopics": $topics,
        "instruction": "Use these trending topics as input for content-writer skill. Match with your content calendar and brand voice."
      }'
    ;;

  *)
    error_exit "Unknown action: $ACTION. Valid: save, list, latest, suggest"
    ;;
esac
