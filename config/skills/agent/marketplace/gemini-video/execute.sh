#!/bin/bash
# Gemini Video Understanding Skill
# Analyzes videos (YouTube URLs or local files) using Google's Gemini API.
# Input: JSON with url/file, prompt, model, output fields.
# Output: JSON with analysis text and metadata.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

# --- Constants ---
GEMINI_API_BASE="https://generativelanguage.googleapis.com"
GEMINI_UPLOAD_URL="${GEMINI_API_BASE}/upload/v1beta/files"
GEMINI_CONTENT_URL="${GEMINI_API_BASE}/v1beta/models"
MODEL_STANDARD="gemini-2.0-flash"
MODEL_ADVANCED="gemini-2.5-flash"
MAX_UPLOAD_BYTES=2147483648  # 2GB
SUPPORTED_EXTENSIONS="mp4|webm|mov|avi|mkv|flv"

DEFAULT_PROMPT='Provide a comprehensive analysis of this video. Structure your response with these sections:

## Summary
A thorough summary of the video content.

## Key Points & Takeaways
Bullet points of the most important information.

## Notable Quotes / Transcript Highlights
Direct quotes or closely paraphrased statements from the speaker(s).

## People & Context
Who is speaking, what is the setting, and what is the broader context.

## Technologies & Tools Mentioned
List any technologies, tools, platforms, or products referenced.

Be thorough, specific, and well-structured.'

# --- Validate environment ---
if [ -z "${GEMINI_API_KEY:-}" ]; then
  error_exit "GEMINI_API_KEY environment variable is not set"
fi

# --- Parse input ---
INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit 'Usage: execute.sh '\''{"url":"https://youtu.be/xxx","prompt":"Summarize this video"}'\'' or {"file":"/path/to/video.mp4","prompt":"..."}'

VIDEO_URL=$(printf '%s' "$INPUT" | jq -r '.url // empty')
VIDEO_FILE=$(printf '%s' "$INPUT" | jq -r '.file // empty')
USER_PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty')
MODEL_CHOICE=$(printf '%s' "$INPUT" | jq -r '.model // "standard"')
OUTPUT_FILE=$(printf '%s' "$INPUT" | jq -r '.output // empty')

# Validate: need either url or file
if [ -z "$VIDEO_URL" ] && [ -z "$VIDEO_FILE" ]; then
  error_exit "Either 'url' (YouTube URL) or 'file' (local video path) is required"
fi

# Select model
case "$MODEL_CHOICE" in
  advanced|pro) MODEL="$MODEL_ADVANCED" ;;
  *)            MODEL="$MODEL_STANDARD" ;;
esac

# Use default prompt if none provided
PROMPT="${USER_PROMPT:-$DEFAULT_PROMPT}"

# --- Helper: call Gemini generateContent ---
call_gemini() {
  local payload="$1"
  local response
  response=$(curl -s -w '\n%{http_code}' -X POST \
    "${GEMINI_CONTENT_URL}/${MODEL}:generateContent?key=${GEMINI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1)

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" -ge 200 ] 2>/dev/null && [ "$http_code" -lt 300 ] 2>/dev/null; then
    echo "$body"
  else
    local err_msg
    err_msg=$(echo "$body" | jq -r '.error.message // "API request failed"' 2>/dev/null || echo "API request failed with HTTP $http_code")
    error_exit "Gemini API error (HTTP $http_code): $err_msg"
  fi
}

# --- Helper: get MIME type from extension ---
get_mime_type() {
  local ext="${1##*.}"
  ext=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
  case "$ext" in
    mp4)  echo "video/mp4" ;;
    webm) echo "video/webm" ;;
    mov)  echo "video/quicktime" ;;
    avi)  echo "video/x-msvideo" ;;
    mkv)  echo "video/x-matroska" ;;
    flv)  echo "video/x-flv" ;;
    *)    echo "video/mp4" ;;
  esac
}

# --- Helper: upload local file to Gemini Files API ---
upload_file() {
  local filepath="$1"
  local mime_type="$2"
  local display_name
  display_name=$(basename "$filepath")

  # Start resumable upload
  local init_response
  init_response=$(curl -s -D- -X POST \
    "${GEMINI_UPLOAD_URL}?key=${GEMINI_API_KEY}" \
    -H "X-Goog-Upload-Protocol: resumable" \
    -H "X-Goog-Upload-Command: start" \
    -H "X-Goog-Upload-Header-Content-Length: $(wc -c < "$filepath" | tr -d ' ')" \
    -H "X-Goog-Upload-Header-Content-Type: ${mime_type}" \
    -H "Content-Type: application/json" \
    -d "{\"file\":{\"display_name\":\"${display_name}\"}}" 2>&1)

  local upload_url
  upload_url=$(echo "$init_response" | grep -i 'x-goog-upload-url:' | sed 's/.*: //' | tr -d '\r')

  if [ -z "$upload_url" ]; then
    error_exit "Failed to initiate file upload. Could not get upload URL."
  fi

  # Upload the file bytes
  local upload_response
  upload_response=$(curl -s -X POST "$upload_url" \
    -H "X-Goog-Upload-Offset: 0" \
    -H "X-Goog-Upload-Command: upload, finalize" \
    -H "Content-Type: ${mime_type}" \
    --data-binary "@${filepath}" 2>&1)

  local file_uri
  file_uri=$(echo "$upload_response" | jq -r '.file.uri // empty' 2>/dev/null)

  if [ -z "$file_uri" ]; then
    local err
    err=$(echo "$upload_response" | jq -r '.error.message // "Upload failed"' 2>/dev/null || echo "Upload failed")
    error_exit "File upload failed: $err"
  fi

  # Wait for file to become ACTIVE
  local file_name
  file_name=$(echo "$upload_response" | jq -r '.file.name // empty')
  local state="PROCESSING"
  local attempts=0
  local max_attempts=60

  while [ "$state" = "PROCESSING" ] && [ "$attempts" -lt "$max_attempts" ]; do
    sleep 5
    local status_response
    status_response=$(curl -s "${GEMINI_API_BASE}/v1beta/${file_name}?key=${GEMINI_API_KEY}" 2>&1)
    state=$(echo "$status_response" | jq -r '.state // "PROCESSING"' 2>/dev/null)
    attempts=$((attempts + 1))
  done

  if [ "$state" != "ACTIVE" ]; then
    error_exit "File upload timed out or failed. State: $state"
  fi

  echo "$file_uri"
}

# --- Main: YouTube URL analysis ---
if [ -n "$VIDEO_URL" ]; then
  # Build payload with YouTube URL as file_data
  ESCAPED_PROMPT=$(echo "$PROMPT" | jq -Rs '.')
  PAYLOAD=$(cat <<ENDJSON
{
  "contents": [
    {
      "parts": [
        {
          "file_data": {
            "mime_type": "video/*",
            "file_uri": "${VIDEO_URL}"
          }
        },
        {
          "text": ${ESCAPED_PROMPT}
        }
      ]
    }
  ]
}
ENDJSON
)

  RESPONSE=$(call_gemini "$PAYLOAD")

# --- Main: Local file analysis ---
elif [ -n "$VIDEO_FILE" ]; then
  # Validate file exists
  if [ ! -f "$VIDEO_FILE" ]; then
    error_exit "Video file not found: $VIDEO_FILE"
  fi

  # Validate extension
  local_ext="${VIDEO_FILE##*.}"
  local_ext_lower=$(echo "$local_ext" | tr '[:upper:]' '[:lower:]')
  if ! echo "$local_ext_lower" | grep -qE "^(${SUPPORTED_EXTENSIONS})$"; then
    error_exit "Unsupported video format: .${local_ext_lower}. Supported: mp4, webm, mov, avi, mkv, flv"
  fi

  # Validate file size
  FILE_SIZE=$(wc -c < "$VIDEO_FILE" | tr -d ' ')
  if [ "$FILE_SIZE" -gt "$MAX_UPLOAD_BYTES" ]; then
    error_exit "File too large ($(( FILE_SIZE / 1048576 ))MB). Maximum: 2048MB"
  fi

  MIME_TYPE=$(get_mime_type "$VIDEO_FILE")

  # Upload to Gemini Files API
  echo '{"status":"uploading","message":"Uploading video to Gemini Files API..."}' >&2
  FILE_URI=$(upload_file "$VIDEO_FILE" "$MIME_TYPE")
  echo "{\"status\":\"uploaded\",\"message\":\"Upload complete. Analyzing video...\",\"fileUri\":\"${FILE_URI}\"}" >&2

  # Build payload with uploaded file URI
  ESCAPED_PROMPT=$(echo "$PROMPT" | jq -Rs '.')
  PAYLOAD=$(cat <<ENDJSON
{
  "contents": [
    {
      "parts": [
        {
          "file_data": {
            "mime_type": "${MIME_TYPE}",
            "file_uri": "${FILE_URI}"
          }
        },
        {
          "text": ${ESCAPED_PROMPT}
        }
      ]
    }
  ]
}
ENDJSON
)

  RESPONSE=$(call_gemini "$PAYLOAD")
fi

# --- Extract and output results ---
ANALYSIS_TEXT=$(echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // "No analysis text returned"')
PROMPT_TOKENS=$(echo "$RESPONSE" | jq -r '.usageMetadata.promptTokenCount // 0')
RESPONSE_TOKENS=$(echo "$RESPONSE" | jq -r '.usageMetadata.candidatesTokenCount // 0')
MODEL_VERSION=$(echo "$RESPONSE" | jq -r '.modelVersion // "unknown"')

# Save to file if output path specified
if [ -n "$OUTPUT_FILE" ]; then
  echo "$ANALYSIS_TEXT" > "$OUTPUT_FILE"
fi

# Output structured JSON
jq -n \
  --arg analysis "$ANALYSIS_TEXT" \
  --arg model "$MODEL_VERSION" \
  --argjson promptTokens "$PROMPT_TOKENS" \
  --argjson responseTokens "$RESPONSE_TOKENS" \
  --arg source "${VIDEO_URL:-$VIDEO_FILE}" \
  --arg outputFile "${OUTPUT_FILE:-}" \
  '{
    success: true,
    source: $source,
    model: $model,
    analysis: $analysis,
    tokens: {
      prompt: $promptTokens,
      response: $responseTokens,
      total: ($promptTokens + $responseTokens)
    },
    outputFile: (if $outputFile == "" then null else $outputFile end)
  }'
