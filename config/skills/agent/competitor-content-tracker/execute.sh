#!/bin/bash
# Competitor Content Tracker — store, query, and compare competitor content data
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"save|list|compare|latest\",\"competitor\":\"crewai\",...}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

require_param "action" "$ACTION"

# Resolve storage directory
if [ -n "$PROJECT_PATH" ]; then
  TRACKER_DIR="${PROJECT_PATH}/.crewly/content/competitors"
else
  TRACKER_DIR="${HOME}/.crewly/content/competitors"
fi
mkdir -p "$TRACKER_DIR"

# Valid competitors
validate_competitor() {
  case "$1" in
    crewai|n8n|relevance-ai|autogen|langchain|langraph|openai|other) return 0 ;;
    *) error_exit "Unknown competitor: $1. Valid: crewai, n8n, relevance-ai, autogen, langchain, langraph, openai, other" ;;
  esac
}

case "$ACTION" in

  # ─────────────────────────────────────────────
  # SAVE: Store content items from a competitor scan
  # ─────────────────────────────────────────────
  save)
    COMPETITOR=$(printf '%s' "$INPUT" | jq -r '.competitor // empty')
    SOURCE_TYPE=$(printf '%s' "$INPUT" | jq -r '.sourceType // empty')
    ITEMS=$(printf '%s' "$INPUT" | jq -r '.items // empty')

    require_param "competitor" "$COMPETITOR"
    require_param "sourceType" "$SOURCE_TYPE"
    require_param "items" "$ITEMS"

    validate_competitor "$COMPETITOR"

    # Validate source type
    case "$SOURCE_TYPE" in
      blog|twitter|linkedin|github-release|changelog|youtube|community|press|other) ;;
      *) error_exit "Invalid sourceType: $SOURCE_TYPE. Valid: blog, twitter, linkedin, github-release, changelog, youtube, community, press, other" ;;
    esac

    # Validate items is a JSON array
    if ! echo "$ITEMS" | jq 'type == "array"' 2>/dev/null | grep -q true; then
      error_exit "items must be a JSON array"
    fi

    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    TODAY=$(date -u +%Y-%m-%d)
    SCAN_ID="comp-$(date +%s)-$((RANDOM % 1000))"

    # Enrich items with metadata
    ENRICHED=$(echo "$ITEMS" | jq \
      --arg competitor "$COMPETITOR" \
      --arg sourceType "$SOURCE_TYPE" \
      --arg scanId "$SCAN_ID" \
      --arg ts "$NOW" \
      '[.[] | . + {"competitor": $competitor, "sourceType": $sourceType, "scanId": $scanId, "scannedAt": $ts}]')

    COUNT=$(echo "$ENRICHED" | jq 'length')

    # Save to competitor-specific file
    COMP_DIR="${TRACKER_DIR}/${COMPETITOR}"
    mkdir -p "$COMP_DIR"
    SCAN_FILE="${COMP_DIR}/${TODAY}-${SOURCE_TYPE}.json"

    if [ -f "$SCAN_FILE" ]; then
      EXISTING=$(cat "$SCAN_FILE")
      MERGED=$(jq -n --argjson existing "$EXISTING" --argjson new "$ENRICHED" \
        '{"scans": ($existing.scans + [{"scanId": $new[0].scanId, "scannedAt": $new[0].scannedAt, "count": ($new | length), "items": $new}])}')
      echo "$MERGED" > "$SCAN_FILE"
    else
      jq -n --argjson items "$ENRICHED" --arg competitor "$COMPETITOR" --arg sourceType "$SOURCE_TYPE" --arg date "$TODAY" \
        '{"competitor": $competitor, "sourceType": $sourceType, "date": $date, "scans": [{"scanId": $items[0].scanId, "scannedAt": $items[0].scannedAt, "count": ($items | length), "items": $items}]}' > "$SCAN_FILE"
    fi

    jq -n \
      --arg scanId "$SCAN_ID" \
      --arg competitor "$COMPETITOR" \
      --arg sourceType "$SOURCE_TYPE" \
      --argjson count "$COUNT" \
      --arg file "$SCAN_FILE" \
      '{"success":true,"action":"save","scanId":$scanId,"competitor":$competitor,"sourceType":$sourceType,"count":$count,"file":$file}'
    ;;

  # ─────────────────────────────────────────────
  # LIST: List tracked content by competitor
  # ─────────────────────────────────────────────
  list)
    FILTER_COMP=$(printf '%s' "$INPUT" | jq -r '.competitor // empty')
    LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // "20"')

    RESULTS="[]"

    SEARCH_DIRS=""
    if [ -n "$FILTER_COMP" ]; then
      validate_competitor "$FILTER_COMP"
      SEARCH_DIRS="${TRACKER_DIR}/${FILTER_COMP}"
    else
      SEARCH_DIRS="$TRACKER_DIR"
    fi

    for f in $(find "$SEARCH_DIRS" -name "*.json" -type f 2>/dev/null | sort -r | head -"$LIMIT"); do
      [ -f "$f" ] || continue
      COMP=$(jq -r '.competitor // "unknown"' "$f" 2>/dev/null || echo "unknown")
      STYPE=$(jq -r '.sourceType // "unknown"' "$f" 2>/dev/null || echo "unknown")
      FDATE=$(jq -r '.date // "unknown"' "$f" 2>/dev/null || echo "unknown")
      TOTAL=$(jq '[.scans[].count] | add // 0' "$f" 2>/dev/null || echo "0")
      LAST=$(jq -r '.scans[-1].scannedAt // "unknown"' "$f" 2>/dev/null || echo "unknown")

      RESULTS=$(echo "$RESULTS" | jq \
        --arg file "$f" \
        --arg competitor "$COMP" \
        --arg sourceType "$STYPE" \
        --arg date "$FDATE" \
        --argjson totalItems "$TOTAL" \
        --arg lastScan "$LAST" \
        '. + [{"file":$file,"competitor":$competitor,"sourceType":$sourceType,"date":$date,"totalItems":$totalItems,"lastScan":$lastScan}]')
    done

    COUNT=$(echo "$RESULTS" | jq 'length')
    jq -n --argjson results "$RESULTS" --argjson count "$COUNT" \
      '{"success":true,"action":"list","count":$count,"results":$results}'
    ;;

  # ─────────────────────────────────────────────
  # LATEST: Get latest content from a competitor
  # ─────────────────────────────────────────────
  latest)
    FILTER_COMP=$(printf '%s' "$INPUT" | jq -r '.competitor // empty')
    FILTER_TYPE=$(printf '%s' "$INPUT" | jq -r '.sourceType // empty')
    LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // "15"')

    require_param "competitor" "$FILTER_COMP"
    validate_competitor "$FILTER_COMP"

    COMP_DIR="${TRACKER_DIR}/${FILTER_COMP}"
    ALL_ITEMS="[]"

    if [ -d "$COMP_DIR" ]; then
      for f in $(ls -t "$COMP_DIR"/*.json 2>/dev/null | head -5); do
        [ -f "$f" ] || continue
        if [ -n "$FILTER_TYPE" ]; then
          STYPE=$(jq -r '.sourceType // ""' "$f")
          [ "$STYPE" != "$FILTER_TYPE" ] && continue
        fi
        ITEMS=$(jq '.scans[-1].items // []' "$f" 2>/dev/null || echo "[]")
        ALL_ITEMS=$(jq -n --argjson a "$ALL_ITEMS" --argjson b "$ITEMS" '$a + $b')
      done
    fi

    ALL_ITEMS=$(echo "$ALL_ITEMS" | jq --argjson limit "$LIMIT" '.[:$limit]')
    COUNT=$(echo "$ALL_ITEMS" | jq 'length')

    jq -n --arg competitor "$FILTER_COMP" --argjson items "$ALL_ITEMS" --argjson count "$COUNT" \
      '{"success":true,"action":"latest","competitor":$competitor,"count":$count,"items":$items}'
    ;;

  # ─────────────────────────────────────────────
  # COMPARE: Compare content activity across competitors
  # ─────────────────────────────────────────────
  compare)
    COMPETITORS_INPUT=$(printf '%s' "$INPUT" | jq -r '.competitors // "crewai,n8n,relevance-ai"')
    DAYS=$(printf '%s' "$INPUT" | jq -r '.days // "7"')

    IFS=',' read -ra COMP_ARRAY <<< "$COMPETITORS_INPUT"

    # Calculate date threshold
    THRESHOLD=$(date -u -v-"${DAYS}"d +%Y-%m-%d 2>/dev/null || date -u -d "-${DAYS} days" +%Y-%m-%d 2>/dev/null || date -u +%Y-%m-%d)

    COMPARISON="[]"

    for comp in "${COMP_ARRAY[@]}"; do
      comp=$(echo "$comp" | xargs)
      COMP_DIR="${TRACKER_DIR}/${comp}"

      TOTAL_ITEMS=0
      BY_TYPE="{}"
      LATEST_TITLES="[]"

      if [ -d "$COMP_DIR" ]; then
        for f in "$COMP_DIR"/*.json; do
          [ -f "$f" ] || continue
          FDATE=$(jq -r '.date // ""' "$f" 2>/dev/null)
          [ -z "$FDATE" ] && continue

          if [ "$FDATE" \> "$THRESHOLD" ] || [ "$FDATE" = "$THRESHOLD" ]; then
            STYPE=$(jq -r '.sourceType // "unknown"' "$f" 2>/dev/null)
            FCOUNT=$(jq '[.scans[].count] | add // 0' "$f" 2>/dev/null || echo "0")
            TOTAL_ITEMS=$((TOTAL_ITEMS + FCOUNT))

            BY_TYPE=$(echo "$BY_TYPE" | jq --arg t "$STYPE" --argjson c "$FCOUNT" \
              '. + {($t): ((.[$t] // 0) + $c)}')

            # Get latest titles
            TITLES=$(jq '[.scans[-1].items[:3][] | .title // "untitled"]' "$f" 2>/dev/null || echo "[]")
            LATEST_TITLES=$(jq -n --argjson a "$LATEST_TITLES" --argjson b "$TITLES" '$a + $b')
          fi
        done
      fi

      LATEST_TITLES=$(echo "$LATEST_TITLES" | jq '.[:5]')

      COMPARISON=$(echo "$COMPARISON" | jq \
        --arg competitor "$comp" \
        --argjson totalItems "$TOTAL_ITEMS" \
        --argjson byType "$BY_TYPE" \
        --argjson latestTitles "$LATEST_TITLES" \
        '. + [{"competitor":$competitor,"totalItems":$totalItems,"bySourceType":$byType,"recentTitles":$latestTitles}]')
    done

    jq -n \
      --argjson comparison "$COMPARISON" \
      --arg period "${DAYS} days" \
      --arg since "$THRESHOLD" \
      '{"success":true,"action":"compare","period":$period,"since":$since,"competitors":$comparison}'
    ;;

  *)
    error_exit "Unknown action: $ACTION. Valid: save, list, latest, compare"
    ;;
esac
