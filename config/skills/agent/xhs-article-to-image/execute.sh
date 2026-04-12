#!/bin/bash
# Convert markdown articles into XiaoHongShu-style image cards (1080x1440 PNG)
# Uses Playwright to render HTML+CSS templates and capture screenshots.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"content\":\"# Title\\n\\nBody...\",\"outputDir\":\"/tmp/xhs\"}' or '{\"sourceFile\":\"/path/to/article.md\",\"outputDir\":\"/tmp/xhs\"}'"

# Parse parameters
CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
SOURCE_FILE=$(printf '%s' "$INPUT" | jq -r '.sourceFile // empty')
OUTPUT_DIR=$(printf '%s' "$INPUT" | jq -r '.outputDir // empty')
TITLE_OVERRIDE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
AUTHOR=$(printf '%s' "$INPUT" | jq -r '.author // empty')
ACCENT_COLOR=$(printf '%s' "$INPUT" | jq -r '.accentColor // "#1a1a1a"')
BG_COLOR=$(printf '%s' "$INPUT" | jq -r '.bgColor // "#fafaf8"')
MAX_CHARS=$(printf '%s' "$INPUT" | jq -r '.maxCharsPerPage // "350"')
COVER_IMAGE=$(printf '%s' "$INPUT" | jq -r '.coverImage // empty')

# Load content from file if sourceFile is provided
if [ -n "$SOURCE_FILE" ]; then
  if [ ! -f "$SOURCE_FILE" ]; then
    error_exit "Source file not found: $SOURCE_FILE"
  fi
  CONTENT=$(cat "$SOURCE_FILE")
fi

require_param "content" "$CONTENT"
require_param "outputDir" "$OUTPUT_DIR"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Extract title from markdown (first # heading)
if [ -n "$TITLE_OVERRIDE" ]; then
  TITLE="$TITLE_OVERRIDE"
else
  TITLE=$(echo "$CONTENT" | grep -m1 '^# ' | sed 's/^# //' || echo "Untitled")
  if [ -z "$TITLE" ]; then
    TITLE="Untitled"
  fi
fi

# Remove title line from content body
BODY=$(echo "$CONTENT" | sed '0,/^# .*$/d')
if [ -z "$BODY" ]; then
  BODY="$CONTENT"
fi

# ─── Split content into pages ─────────────────────────────────────────────────
# Split on explicit --- page breaks first, then by character count

# Use node to do the splitting and rendering (complex text processing)
RENDER_INPUT=$(jq -n \
  --arg title "$TITLE" \
  --arg author "$AUTHOR" \
  --arg accentColor "$ACCENT_COLOR" \
  --arg bgColor "$BG_COLOR" \
  --arg outputDir "$OUTPUT_DIR" \
  --arg coverImage "$COVER_IMAGE" \
  --arg body "$BODY" \
  --argjson maxChars "$MAX_CHARS" \
  '{
    title: $title,
    author: $author,
    accentColor: $accentColor,
    bgColor: $bgColor,
    outputDir: $outputDir,
    coverImage: $coverImage,
    maxChars: $maxChars,
    body: $body
  }')

# Use Node.js to split content into pages (handles complex markdown parsing)
PAGES_JSON=$(node -e "
const input = JSON.parse(process.argv[1]);
const body = input.body;
const maxChars = input.maxChars;

function splitIntoPages(markdown, maxChars) {
  const explicitSections = markdown.split(/\n---\n/).filter(s => s.trim());
  const pages = [];
  for (const section of explicitSections) {
    if (section.length <= maxChars) {
      pages.push(section.trim());
      continue;
    }
    const blocks = section.split(/\n\n/).filter(b => b.trim());
    let currentPage = '';
    for (const block of blocks) {
      if (currentPage.length > 0 && currentPage.length + block.length > maxChars) {
        pages.push(currentPage.trim());
        currentPage = block;
      } else {
        currentPage += (currentPage ? '\n\n' : '') + block;
      }
    }
    if (currentPage.trim()) pages.push(currentPage.trim());
  }
  return pages.length > 0 ? pages : [markdown.trim()];
}

const pages = splitIntoPages(body, maxChars);
console.log(JSON.stringify(pages));
" "$RENDER_INPUT")

# Build final render input with pages array
FINAL_INPUT=$(printf '%s' "$RENDER_INPUT" | jq --argjson pages "$PAGES_JSON" '. + {pages: $pages} | del(.body, .maxChars)')

# Run Playwright renderer
RESULT=$(node "$SCRIPT_DIR/render.mjs" "$FINAL_INPUT" 2>&1)

# Check for errors
if echo "$RESULT" | jq -e '.success == true' > /dev/null 2>&1; then
  echo "$RESULT" | jq --arg title "$TITLE" '. + {title: $title}'
else
  error_exit "Rendering failed: $RESULT"
fi
