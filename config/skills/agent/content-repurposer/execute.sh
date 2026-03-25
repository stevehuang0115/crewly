#!/bin/bash
# Repurpose source content into platform-optimized versions
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"source\":\"content text\",\"platforms\":\"x-thread,linkedin,xiaohongshu\",\"tone\":\"professional\",\"brand\":\"personal\",\"outputDir\":\"/path/to/output\"}'"

# Parse parameters
SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty')
SOURCE_FILE=$(printf '%s' "$INPUT" | jq -r '.sourceFile // empty')
PLATFORMS=$(printf '%s' "$INPUT" | jq -r '.platforms // "x-thread,linkedin"')
TONE=$(printf '%s' "$INPUT" | jq -r '.tone // "professional"')
OUTPUT_DIR=$(printf '%s' "$INPUT" | jq -r '.outputDir // empty')
BRAND=$(printf '%s' "$INPUT" | jq -r '.brand // "personal"')
LANGUAGE=$(printf '%s' "$INPUT" | jq -r '.language // "auto"')

# Load source content from file if sourceFile is provided
if [ -n "$SOURCE_FILE" ]; then
  if [ ! -f "$SOURCE_FILE" ]; then
    error_exit "Source file not found: $SOURCE_FILE"
  fi
  SOURCE=$(cat "$SOURCE_FILE")
fi

require_param "source" "$SOURCE"

# Truncate source for processing (keep first 4000 chars)
if [ ${#SOURCE} -gt 4000 ]; then
  SOURCE="${SOURCE:0:4000}..."
fi

# --- Platform config lookup functions (bash 3.x compatible) ---

get_platform_max_len() {
  case "$1" in
    x-thread)     echo "1400" ;;
    x-single)     echo "280" ;;
    linkedin)     echo "3000" ;;
    xiaohongshu)  echo "1000" ;;
    substack)     echo "10000" ;;
    youtube-desc) echo "5000" ;;
    *)            echo "" ;;
  esac
}

get_platform_style() {
  case "$1" in
    x-thread)
      echo "Split into 3-7 tweets (each <=280 chars). Start with a strong hook. Use line breaks between tweets. Mark tweet boundaries with [1/N] format. Include 2-3 relevant hashtags on the last tweet only. Conversational, punchy, opinionated." ;;
    x-single)
      echo "Single tweet, max 280 chars. Punchy hook + key insight. 1-2 hashtags max." ;;
    linkedin)
      echo "Professional long-form post, 150-300 words. Start with a bold opening line. Use short paragraphs (1-2 sentences each). Include a clear takeaway or call-to-action. Data-driven where possible. No hashtags in the body, add 3-5 hashtags at the very end." ;;
    xiaohongshu)
      echo "Chinese language (Simplified). Casual, relatable tone with emoji. Start with an attention-grabbing title line. Use bullet points and short paragraphs. Include 5-8 topic hashtags in #topic# format at the end. Target audience: Chinese tech professionals, entrepreneurs, AI enthusiasts." ;;
    substack)
      echo "Long-form article/newsletter format. Include a compelling title, subtitle, and structured sections with H2/H3 headers. Write 500-1500 words expanding on the source. Include a personal anecdote or insight. End with a discussion prompt for reader engagement." ;;
    youtube-desc)
      echo "YouTube video description format. Start with a 2-3 sentence summary. Include timestamps placeholder [00:00 - Topic]. Add relevant links section. Include 10-15 tags/keywords comma-separated at the bottom. Keep under 5000 chars." ;;
    *)
      echo "" ;;
  esac
}

get_platform_suffix() {
  case "$1" in
    x-thread)     echo "x-thread.md" ;;
    x-single)     echo "x-single.md" ;;
    linkedin)     echo "linkedin.md" ;;
    xiaohongshu)  echo "xiaohongshu.md" ;;
    substack)     echo "substack.md" ;;
    youtube-desc) echo "youtube-desc.md" ;;
    *)            echo "" ;;
  esac
}

get_tone_desc() {
  case "$1" in
    professional) echo "Professional and authoritative. Data-driven. Measured confidence." ;;
    casual)       echo "Conversational and approachable. Uses humor sparingly. Feels like talking to a smart friend." ;;
    technical)    echo "Precise and detailed. Assumes technical audience. Uses specific terminology." ;;
    inspiring)    echo "Motivational and forward-looking. Personal stories. Empowering language." ;;
    provocative)  echo "Bold and contrarian. Challenges conventional wisdom. Strong opinions backed by reasoning." ;;
    *)            echo "Professional and authoritative. Data-driven. Measured confidence." ;;
  esac
}

get_brand_voice() {
  case "$1" in
    personal) echo "Steve's personal voice: Google PM with 7 years experience, side hustle enthusiast (24 projects), AI-native builder, Build in Public advocate. Speaks from first-person experience. Boston-based, bilingual (EN/CN)." ;;
    crewly)   echo "Crewly brand voice: Technical but not boring. Developer-first. Concise and powerful. Honest about limitations. Uses concrete examples and code snippets. Tagline: Your AI Team, Ready in Days - Not Months." ;;
    *)        echo "Professional voice with authentic personal touch." ;;
  esac
}

# --- Resolve tone and brand ---
TONE_MODIFIER=$(get_tone_desc "$TONE")
BRAND_MODIFIER=$(get_brand_voice "$BRAND")

# Parse platforms
IFS=',' read -ra PLATFORM_ARRAY <<< "$PLATFORMS"

RESULTS="[]"
FILES_WRITTEN="[]"

for platform in "${PLATFORM_ARRAY[@]}"; do
  platform=$(echo "$platform" | xargs | tr '[:upper:]' '[:lower:]')

  MAX_LEN=$(get_platform_max_len "$platform")
  STYLE=$(get_platform_style "$platform")
  SUFFIX=$(get_platform_suffix "$platform")

  if [ -z "$STYLE" ]; then
    RESULTS=$(echo "$RESULTS" | jq \
      --arg platform "$platform" \
      '. + [{"platform":$platform,"error":"Unsupported platform. Use: x-thread, x-single, linkedin, xiaohongshu, substack, youtube-desc"}]')
    continue
  fi

  # Language instruction
  LANG_INSTRUCTION=""
  if [ "$LANGUAGE" = "auto" ]; then
    if [ "$platform" = "xiaohongshu" ]; then
      LANG_INSTRUCTION="Write in Simplified Chinese."
    else
      LANG_INSTRUCTION="Write in English."
    fi
  elif [ "$LANGUAGE" = "zh" ]; then
    LANG_INSTRUCTION="Write in Simplified Chinese."
  elif [ "$LANGUAGE" = "en" ]; then
    LANG_INSTRUCTION="Write in English."
  elif [ "$LANGUAGE" = "both" ]; then
    LANG_INSTRUCTION="Write in English with key phrases in Chinese where natural."
  fi

  # Write prompt file if outputDir specified
  FILE_PATH=""
  if [ -n "$OUTPUT_DIR" ]; then
    mkdir -p "$OUTPUT_DIR"
    FILE_PATH="${OUTPUT_DIR}/${SUFFIX}"
    cat > "$FILE_PATH" <<PROMPT_EOF
--- PLATFORM: ${platform} ---
MAX_LENGTH: ${MAX_LEN} chars
STYLE: ${STYLE}
TONE: ${TONE_MODIFIER}
BRAND: ${BRAND_MODIFIER}
${LANG_INSTRUCTION}
---

SOURCE CONTENT TO REPURPOSE:
${SOURCE}
PROMPT_EOF
    FILES_WRITTEN=$(echo "$FILES_WRITTEN" | jq --arg fp "$FILE_PATH" '. + [$fp]')
  fi

  RESULTS=$(echo "$RESULTS" | jq \
    --arg platform "$platform" \
    --arg maxLen "$MAX_LEN" \
    --arg style "$STYLE" \
    --arg tone "$TONE_MODIFIER" \
    --arg brand "$BRAND_MODIFIER" \
    --arg lang "$LANG_INSTRUCTION" \
    --arg filePath "$FILE_PATH" \
    '. + [{
      "platform": $platform,
      "maxLength": ($maxLen | tonumber),
      "styleGuide": $style,
      "toneGuide": $tone,
      "brandVoice": $brand,
      "language": $lang,
      "outputFile": $filePath
    }]')
done

# Build output
OUTPUT=$(jq -n \
  --arg sourceLength "${#SOURCE}" \
  --arg tone "$TONE" \
  --arg brand "$BRAND" \
  --argjson platforms "$RESULTS" \
  --argjson filesWritten "$FILES_WRITTEN" \
  '{
    "success": true,
    "sourceContentLength": ($sourceLength | tonumber),
    "tone": $tone,
    "brand": $brand,
    "platforms": $platforms,
    "filesWritten": $filesWritten,
    "instructions": "Each platform entry contains the style guide, tone, brand voice, and language instructions. Use these as system prompts when generating the actual repurposed content with an LLM. If outputDir was specified, prompt files have been written to disk."
  }')

echo "$OUTPUT"
