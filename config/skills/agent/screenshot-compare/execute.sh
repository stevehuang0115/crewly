#!/bin/bash
# Screenshot Compare — Gemini Vision API dual-image comparison
#
# Sends two screenshots (e.g., iOS reference + Web implementation) to
# Gemini Vision and returns a structured diff report.
#
# Usage:
#   bash execute.sh '{"reference":"/path/to/ios-screenshot.png","target":"/path/to/web-screenshot.png"}'
#   bash execute.sh '{"reference":"ref.png","target":"web.png","focus":"icons,layout,colors"}'
#
# Requires: GEMINI_API_KEY environment variable
#
# Output: JSON with differences categorized by type (icon, layout, color, text, image)

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
MODEL="${GEMINI_MODEL:-gemini-2.0-flash}"
GEMINI_API_BASE="https://generativelanguage.googleapis.com"
GEMINI_CONTENT_URL="${GEMINI_API_BASE}/v1beta/models/${MODEL}:generateContent"
MAX_IMAGE_SIZE_MB=4

# ── Input parsing ──────────────────────────────────────────────────────────────
INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  echo '{"success":false,"error":"Usage: execute.sh \u0027{\"reference\":\"/path/to/ref.png\",\"target\":\"/path/to/target.png\"}\u0027"}'
  exit 1
fi

REFERENCE=$(echo "$INPUT" | jq -r '.reference // empty')
TARGET=$(echo "$INPUT" | jq -r '.target // empty')
FOCUS=$(echo "$INPUT" | jq -r '.focus // "all"')
CONTEXT=$(echo "$INPUT" | jq -r '.context // ""')

if [ -z "$REFERENCE" ] || [ -z "$TARGET" ]; then
  echo '{"success":false,"error":"Both reference and target image paths are required"}'
  exit 1
fi

if [ ! -f "$REFERENCE" ]; then
  echo "{\"success\":false,\"error\":\"Reference image not found: $REFERENCE\"}"
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "{\"success\":false,\"error\":\"Target image not found: $TARGET\"}"
  exit 1
fi

# ── API key resolution ─────────────────────────────────────────────────────────
if [ -z "${GEMINI_API_KEY:-}" ]; then
  # Try loading from settings via Crewly API
  GEMINI_API_KEY=$(curl -sf "http://localhost:8787/api/settings" 2>/dev/null | jq -r '.data.apiKeys.global.gemini // empty' 2>/dev/null || true)
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo '{"success":false,"error":"GEMINI_API_KEY not set. Set via environment or Settings > API Keys."}'
  exit 1
fi

# ── Image encoding ─────────────────────────────────────────────────────────────
get_mime_type() {
  local file="$1"
  local ext="${file##*.}"
  case "$ext" in
    png)  echo "image/png" ;;
    jpg|jpeg) echo "image/jpeg" ;;
    gif)  echo "image/gif" ;;
    webp) echo "image/webp" ;;
    *)    echo "image/png" ;;  # default
  esac
}

REF_MIME=$(get_mime_type "$REFERENCE")
TGT_MIME=$(get_mime_type "$TARGET")
REF_B64=$(base64 < "$REFERENCE" | tr -d '\n')
TGT_B64=$(base64 < "$TARGET" | tr -d '\n')

# ── Build prompt ───────────────────────────────────────────────────────────────
FOCUS_INSTRUCTION=""
if [ "$FOCUS" != "all" ]; then
  FOCUS_INSTRUCTION="Focus specifically on these areas: ${FOCUS}."
fi

CONTEXT_INSTRUCTION=""
if [ -n "$CONTEXT" ]; then
  CONTEXT_INSTRUCTION="Additional context: ${CONTEXT}"
fi

PROMPT="You are a pixel-perfect UI comparison expert. Compare these two screenshots:

IMAGE 1 (Reference — the source of truth, e.g., iOS app or design mockup)
IMAGE 2 (Target — the implementation to verify, e.g., web app)

${FOCUS_INSTRUCTION}
${CONTEXT_INSTRUCTION}

Analyze every visible difference and return a JSON array of issues found. Each issue must have:
- \"type\": one of \"icon_missing\", \"icon_wrong\", \"layout_shift\", \"spacing\", \"color_mismatch\", \"text_mismatch\", \"font_mismatch\", \"image_missing\", \"image_wrong\", \"border_radius\", \"shadow\", \"alignment\", \"responsive\", \"other\"
- \"severity\": \"critical\" (functionality broken), \"major\" (clearly visible), \"minor\" (subtle)
- \"element\": which UI element is affected (e.g., \"header logo\", \"submit button\", \"nav bar\")
- \"reference\": what it looks like in Image 1
- \"target\": what it looks like in Image 2
- \"suggestion\": specific CSS/code fix suggestion

Return ONLY valid JSON in this format:
{
  \"summary\": \"Brief overall assessment\",
  \"matchScore\": 85,
  \"totalIssues\": 5,
  \"issues\": [
    {
      \"type\": \"...\",
      \"severity\": \"...\",
      \"element\": \"...\",
      \"reference\": \"...\",
      \"target\": \"...\",
      \"suggestion\": \"...\"
    }
  ]
}"

# ── API call ───────────────────────────────────────────────────────────────────
REQUEST_BODY=$(cat <<ENDJSON
{
  "contents": [{
    "parts": [
      {"text": $(echo "$PROMPT" | jq -Rs .)},
      {
        "inline_data": {
          "mime_type": "${REF_MIME}",
          "data": "${REF_B64}"
        }
      },
      {
        "inline_data": {
          "mime_type": "${TGT_MIME}",
          "data": "${TGT_B64}"
        }
      }
    ]
  }],
  "generationConfig": {
    "temperature": 0.1,
    "maxOutputTokens": 4096,
    "responseMimeType": "application/json"
  }
}
ENDJSON
)

TMPFILE="/tmp/gemini-compare-$(date +%s).json"
echo "$REQUEST_BODY" > "$TMPFILE"
RESPONSE=$(curl -s -X POST \
  "${GEMINI_CONTENT_URL}?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "@${TMPFILE}")
rm -f "$TMPFILE"

HTTP_CODE=$?
if [ $HTTP_CODE -ne 0 ]; then
  echo "{\"success\":false,\"error\":\"Gemini API request failed (curl exit $HTTP_CODE)\"}"
  exit 1
fi

# ── Parse response ─────────────────────────────────────────────────────────────
ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message // empty' 2>/dev/null)
if [ -n "$ERROR_MSG" ]; then
  echo "{\"success\":false,\"error\":\"Gemini API error: $ERROR_MSG\"}"
  exit 1
fi

# Extract the text content from Gemini response
RESULT_TEXT=$(echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // empty' 2>/dev/null)

if [ -z "$RESULT_TEXT" ]; then
  echo '{"success":false,"error":"Empty response from Gemini API"}'
  exit 1
fi

# Output: wrap the Gemini JSON result in a success envelope
echo "{\"success\":true,\"model\":\"${MODEL}\",\"reference\":\"${REFERENCE}\",\"target\":\"${TARGET}\",\"comparison\":${RESULT_TEXT}}"
