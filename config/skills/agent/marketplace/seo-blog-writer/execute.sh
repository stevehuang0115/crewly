#!/bin/bash
# Generate an SEO-optimized blog post outline
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"topic\":\"Blog topic\",\"keywords\":\"keyword1,keyword2\",\"wordCount\":1500,\"outputPath\":\"/tmp/outline.md\"}'"

# Parse parameters
TOPIC=$(printf '%s' "$INPUT" | jq -r '.topic // empty')
KEYWORDS=$(printf '%s' "$INPUT" | jq -r '.keywords // empty')
WORD_COUNT=$(printf '%s' "$INPUT" | jq -r '.wordCount // 1500')
OUTPUT_PATH=$(printf '%s' "$INPUT" | jq -r '.outputPath // empty')

require_param "topic" "$TOPIC"
require_param "keywords" "$KEYWORDS"

# Parse keywords into array
IFS=',' read -ra KW_ARRAY <<< "$KEYWORDS"
PRIMARY_KEYWORD=$(echo "${KW_ARRAY[0]}" | xargs)
SECONDARY_KEYWORDS="[]"
if [ ${#KW_ARRAY[@]} -gt 1 ]; then
  SECONDARY_KEYWORDS=$(printf '%s\n' "${KW_ARRAY[@]:1}" | sed 's/^ *//' | jq -R . | jq -s '.')
fi

# Generate SEO title (50-60 chars target, include primary keyword)
# Truncate topic to fit with keyword
TITLE_BASE="${TOPIC}"
TITLE_LEN=${#TITLE_BASE}
if [ "$TITLE_LEN" -gt 60 ]; then
  TITLE_BASE="${TITLE_BASE:0:57}..."
fi
SEO_TITLE="$TITLE_BASE"

# Generate meta description (150-160 chars)
META_DESC="Learn about ${PRIMARY_KEYWORD}. ${TOPIC} — a comprehensive guide with best practices, tools, and real examples for getting started."
META_LEN=${#META_DESC}
if [ "$META_LEN" -gt 160 ]; then
  META_DESC="${META_DESC:0:157}..."
fi

# Calculate recommended sections based on word count
SECTION_COUNT=5
if [ "$WORD_COUNT" -ge 2000 ]; then
  SECTION_COUNT=6
elif [ "$WORD_COUNT" -le 1000 ]; then
  SECTION_COUNT=4
fi

# Words per section (rough estimate: intro 15%, sections even, conclusion 10%)
INTRO_WORDS=$(( WORD_COUNT * 15 / 100 ))
CONCLUSION_WORDS=$(( WORD_COUNT * 10 / 100 ))
BODY_WORDS=$(( WORD_COUNT - INTRO_WORDS - CONCLUSION_WORDS ))
WORDS_PER_SECTION=$(( BODY_WORDS / SECTION_COUNT ))

# Build outline sections
OUTLINE="[]"

# H1
OUTLINE=$(echo "$OUTLINE" | jq --arg text "$SEO_TITLE" --arg notes "Include primary keyword in the first 60 characters" \
  '. + [{"type":"h1","text":$text,"notes":$notes}]')

# Introduction section
OUTLINE=$(echo "$OUTLINE" | jq --arg words "$INTRO_WORDS" --arg kw "$PRIMARY_KEYWORD" \
  '. + [{"type":"intro","text":"Introduction","notes":"Hook the reader. Include primary keyword (\($kw)) in first paragraph. Target ~\($words) words."}]')

# H2 sections based on topic
SECTION_TEMPLATES=(
  "What Is|Define the concept. Include primary keyword naturally in the first sentence."
  "Why It Matters|Explain benefits and use cases. Include statistics or examples if available."
  "How to Get Started|Step-by-step tutorial format. Use numbered lists. Include secondary keywords."
  "Best Practices and Tips|Actionable advice. Use bullet points. Address common mistakes."
  "Tools and Resources|Comparison or list of tools. Include internal links to your product."
  "Advanced Strategies|Deep-dive for experienced readers. Include secondary keywords."
)

for i in $(seq 0 $((SECTION_COUNT - 1))); do
  TEMPLATE="${SECTION_TEMPLATES[$i]}"
  SECTION_PREFIX=$(echo "$TEMPLATE" | cut -d'|' -f1)
  SECTION_NOTES=$(echo "$TEMPLATE" | cut -d'|' -f2)

  # Build section heading incorporating the topic
  case "$SECTION_PREFIX" in
    "What Is")
      SECTION_TEXT="What Is ${PRIMARY_KEYWORD}?"
      ;;
    "Why It Matters")
      SECTION_TEXT="Why ${PRIMARY_KEYWORD} Matters"
      ;;
    "How to Get Started")
      SECTION_TEXT="How to Get Started with ${PRIMARY_KEYWORD}"
      ;;
    "Best Practices and Tips")
      SECTION_TEXT="Best Practices for ${PRIMARY_KEYWORD}"
      ;;
    "Tools and Resources")
      SECTION_TEXT="Top Tools for ${PRIMARY_KEYWORD}"
      ;;
    "Advanced Strategies")
      SECTION_TEXT="Advanced ${PRIMARY_KEYWORD} Strategies"
      ;;
  esac

  OUTLINE=$(echo "$OUTLINE" | jq \
    --arg text "$SECTION_TEXT" \
    --arg notes "$SECTION_NOTES ~${WORDS_PER_SECTION} words." \
    --arg type "h2" \
    '. + [{"type":$type,"text":$text,"notes":$notes}]')
done

# Conclusion / CTA
OUTLINE=$(echo "$OUTLINE" | jq --arg words "$CONCLUSION_WORDS" \
  '. + [{"type":"h2","text":"Getting Started Today","notes":"Call-to-action section. Summarize key points. Link to product/download. ~\($words) words."}]')

# SEO guidance
TITLE_LENGTH=${#SEO_TITLE}
META_DESC_LENGTH=${#META_DESC}

# Write markdown file if outputPath is provided
OUTPUT_FILE_RESULT="null"
if [ -n "$OUTPUT_PATH" ]; then
  {
    echo "# ${SEO_TITLE}"
    echo ""
    echo "> **Meta Description:** ${META_DESC}"
    echo ""
    echo "**Primary Keyword:** ${PRIMARY_KEYWORD}"
    echo "**Target Word Count:** ${WORD_COUNT}"
    echo ""
    echo "---"
    echo ""
    # Write each section
    echo "$OUTLINE" | jq -r '.[] | if .type == "h1" then "# \(.text)\n\n_\(.notes)_\n" elif .type == "intro" then "## Introduction\n\n_\(.notes)_\n" elif .type == "h2" then "## \(.text)\n\n_\(.notes)_\n" else "" end'
  } > "$OUTPUT_PATH"
  OUTPUT_FILE_RESULT="\"${OUTPUT_PATH}\""
fi

# Output JSON
jq -n \
  --arg title "$SEO_TITLE" \
  --arg metaDescription "$META_DESC" \
  --arg primaryKeyword "$PRIMARY_KEYWORD" \
  --argjson secondaryKeywords "$SECONDARY_KEYWORDS" \
  --arg targetWordCount "$WORD_COUNT" \
  --argjson outline "$OUTLINE" \
  --arg titleLength "$TITLE_LENGTH" \
  --arg metaDescriptionLength "$META_DESC_LENGTH" \
  --argjson outputFile "$OUTPUT_FILE_RESULT" \
  '{
    title: $title,
    metaDescription: $metaDescription,
    primaryKeyword: $primaryKeyword,
    secondaryKeywords: $secondaryKeywords,
    targetWordCount: ($targetWordCount | tonumber),
    outline: $outline,
    seoGuidance: {
      titleLength: ($titleLength | tonumber),
      metaDescriptionLength: ($metaDescriptionLength | tonumber),
      recommendedKeywordDensity: "1-2% for primary keyword",
      internalLinks: 2,
      externalLinks: 3
    },
    outputFile: $outputFile
  }'
