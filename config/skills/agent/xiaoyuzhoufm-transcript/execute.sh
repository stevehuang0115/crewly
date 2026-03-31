#!/bin/bash
# 小宇宙 Podcast Transcript — Extract and transcribe podcast episodes
#
# Pipeline: URL → HTML → audio URL → download → ffmpeg split → Gemini per-chunk → merge
#
# Long podcasts (>15min) are split into 10-minute chunks via ffmpeg,
# each chunk is uploaded and transcribed separately, then merged.
#
# Usage:
#   bash execute.sh '{"url":"https://www.xiaoyuzhoufm.com/episode/69bbc8ea3c625cc5ae21b461"}'
#   bash execute.sh '{"url":"...","outputFile":"/path/to/transcript.md"}'
#   bash execute.sh '{"audioFile":"/path/to/local.m4a"}'
#
# Requires: GEMINI_API_KEY, ffmpeg, curl, jq

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
MODEL="${GEMINI_MODEL:-gemini-2.0-flash}"
GEMINI_API_BASE="https://generativelanguage.googleapis.com"
GEMINI_UPLOAD_URL="${GEMINI_API_BASE}/upload/v1beta/files"
GEMINI_CONTENT_URL="${GEMINI_API_BASE}/v1beta/models/${MODEL}:generateContent"
MAX_WAIT_SECONDS=300
CHUNK_DURATION_SECONDS=600  # 10 minutes per chunk

# ── Input parsing ──────────────────────────────────────────────────────────────
INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  echo '{"success":false,"error":"Usage: execute.sh \u0027{\"url\":\"https://www.xiaoyuzhoufm.com/episode/...\"}\u0027"}'
  exit 1
fi

URL=$(echo "$INPUT" | jq -r '.url // empty')
AUDIO_FILE=$(echo "$INPUT" | jq -r '.audioFile // empty')
OUTPUT_FILE=$(echo "$INPUT" | jq -r '.outputFile // empty')
LANGUAGE=$(echo "$INPUT" | jq -r '.language // "auto"')

if [ -z "$URL" ] && [ -z "$AUDIO_FILE" ]; then
  echo '{"success":false,"error":"Either url or audioFile is required"}'
  exit 1
fi

# ── Dependency check ───────────────────────────────────────────────────────────
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo '{"success":false,"error":"ffmpeg is required but not installed. Install via: brew install ffmpeg"}'
  exit 1
fi

# ── API key resolution ─────────────────────────────────────────────────────────
if [ -z "${GEMINI_API_KEY:-}" ]; then
  GEMINI_API_KEY=$(curl -sf "http://localhost:8787/api/settings" 2>/dev/null \
    | jq -r '.data.apiKeys.global.gemini // empty' 2>/dev/null || true)
fi
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo '{"success":false,"error":"GEMINI_API_KEY not set. Set via environment or Settings > API Keys."}'
  exit 1
fi

# ── Temp directory with auto-cleanup ───────────────────────────────────────────
TMPDIR_WORK=$(mktemp -d /tmp/xiaoyuzhoufm-XXXXXX)
cleanup() { rm -rf "$TMPDIR_WORK"; }
trap cleanup EXIT

# ── Step 1: Extract audio URL from 小宇宙 page ────────────────────────────────
TITLE="Unknown Episode"
AUDIO_URL=""

if [ -n "$URL" ] && [ -z "$AUDIO_FILE" ]; then
  echo '{"status":"fetching","message":"Fetching episode page..."}' >&2

  HTML_FILE="${TMPDIR_WORK}/page.html"
  curl -sL -o "$HTML_FILE" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
    "$URL" 2>/dev/null

  if [ ! -s "$HTML_FILE" ]; then
    echo '{"success":false,"error":"Failed to fetch episode page"}'
    exit 1
  fi

  TITLE=$(grep -o '<title>[^<]*</title>' "$HTML_FILE" \
    | sed 's/<title>//;s/<\/title>//' \
    | sed 's/ - .* | 小宇宙.*//' \
    | head -1)
  [ -z "$TITLE" ] && TITLE="Unknown Episode"

  AUDIO_URL=$(grep -oE 'https://media\.xyzcdn\.net/[^"]*\.(m4a|mp3|aac|ogg)' "$HTML_FILE" | head -1)
  if [ -z "$AUDIO_URL" ]; then
    AUDIO_URL=$(grep -oE 'https://[^"]*\.(m4a|mp3|aac|ogg)' "$HTML_FILE" | grep -v 'apple\|google\|spotify' | head -1)
  fi
  if [ -z "$AUDIO_URL" ]; then
    echo '{"success":false,"error":"Could not find audio URL in page HTML"}'
    exit 1
  fi

  echo "{\"status\":\"downloading\",\"message\":\"Downloading audio...\",\"title\":$(echo "$TITLE" | jq -Rs .)}" >&2

  AUDIO_FILE="${TMPDIR_WORK}/audio.m4a"
  curl -sL -o "$AUDIO_FILE" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
    -H "Referer: https://www.xiaoyuzhoufm.com/" \
    "$AUDIO_URL" 2>/dev/null

  if [ ! -s "$AUDIO_FILE" ]; then
    echo '{"success":false,"error":"Failed to download audio file"}'
    exit 1
  fi
  AUDIO_SIZE=$(wc -c < "$AUDIO_FILE" | tr -d ' ')
  echo "{\"status\":\"downloaded\",\"message\":\"Audio downloaded (${AUDIO_SIZE} bytes)\"}" >&2
fi

if [ ! -f "$AUDIO_FILE" ]; then
  echo "{\"success\":false,\"error\":\"Audio file not found: ${AUDIO_FILE}\"}"
  exit 1
fi

# ── Step 2: Get duration and split into chunks ─────────────────────────────────
DURATION_SECS=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$AUDIO_FILE" 2>/dev/null | cut -d. -f1)
DURATION_SECS=${DURATION_SECS:-0}

CHUNKS_DIR="${TMPDIR_WORK}/chunks"
mkdir -p "$CHUNKS_DIR"

if [ "$DURATION_SECS" -gt "$CHUNK_DURATION_SECONDS" ]; then
  NUM_CHUNKS=$(( (DURATION_SECS + CHUNK_DURATION_SECONDS - 1) / CHUNK_DURATION_SECONDS ))
  echo "{\"status\":\"splitting\",\"message\":\"Splitting ${DURATION_SECS}s audio into ${NUM_CHUNKS} chunks of ${CHUNK_DURATION_SECONDS}s...\"}" >&2

  ffmpeg -i "$AUDIO_FILE" -f segment -segment_time "$CHUNK_DURATION_SECONDS" \
    -c copy -reset_timestamps 1 \
    "${CHUNKS_DIR}/chunk_%03d.m4a" 2>/dev/null

  CHUNK_FILES=$(ls "${CHUNKS_DIR}"/chunk_*.m4a 2>/dev/null | sort)
else
  # Short audio — single chunk
  cp "$AUDIO_FILE" "${CHUNKS_DIR}/chunk_000.m4a"
  CHUNK_FILES="${CHUNKS_DIR}/chunk_000.m4a"
  NUM_CHUNKS=1
  echo "{\"status\":\"splitting\",\"message\":\"Short audio (${DURATION_SECS}s), no splitting needed.\"}" >&2
fi

# ── Helpers: upload + transcribe a single chunk ────────────────────────────────

# Determine MIME type from file extension
get_mime() {
  case "${1##*.}" in
    mp3) echo "audio/mpeg" ;; m4a) echo "audio/mp4" ;; aac) echo "audio/aac" ;;
    ogg) echo "audio/ogg" ;; wav) echo "audio/wav" ;; *) echo "audio/mp4" ;;
  esac
}

upload_and_wait() {
  local filepath="$1"
  local mime_type="$2"
  local file_size
  file_size=$(wc -c < "$filepath" | tr -d ' ')
  local display_name
  display_name=$(basename "$filepath")

  # Resumable upload: init
  local init_resp
  init_resp=$(curl -s -D- -X POST \
    "${GEMINI_UPLOAD_URL}?key=${GEMINI_API_KEY}" \
    -H "X-Goog-Upload-Protocol: resumable" \
    -H "X-Goog-Upload-Command: start" \
    -H "X-Goog-Upload-Header-Content-Length: ${file_size}" \
    -H "X-Goog-Upload-Header-Content-Type: ${mime_type}" \
    -H "Content-Type: application/json" \
    -d "{\"file\":{\"display_name\":\"${display_name}\"}}" 2>&1)

  local upload_url
  upload_url=$(echo "$init_resp" | grep -i 'x-goog-upload-url:' | sed 's/.*: //' | tr -d '\r')
  [ -z "$upload_url" ] && { echo ""; return 1; }

  # Resumable upload: send bytes
  local upload_resp
  upload_resp=$(curl -s -X POST "$upload_url" \
    -H "X-Goog-Upload-Offset: 0" \
    -H "X-Goog-Upload-Command: upload, finalize" \
    -H "Content-Type: ${mime_type}" \
    --data-binary "@${filepath}" 2>&1)

  local file_uri file_name
  file_uri=$(echo "$upload_resp" | jq -r '.file.uri // empty' 2>/dev/null)
  file_name=$(echo "$upload_resp" | jq -r '.file.name // empty' 2>/dev/null)
  [ -z "$file_uri" ] && { echo ""; return 1; }

  # Poll until ACTIVE
  local state="PROCESSING" waited=0
  while [ "$state" = "PROCESSING" ] && [ "$waited" -lt "$MAX_WAIT_SECONDS" ]; do
    sleep 3
    waited=$((waited + 3))
    state=$(curl -s "${GEMINI_API_BASE}/v1beta/${file_name}?key=${GEMINI_API_KEY}" \
      | jq -r '.state // "PROCESSING"' 2>/dev/null)
  done

  [ "$state" != "ACTIVE" ] && { echo ""; return 1; }
  echo "$file_uri"
}

transcribe_chunk() {
  local file_uri="$1"
  local mime_type="$2"
  local chunk_index="$3"
  local total_chunks="$4"

  local lang_hint=""
  [ "$LANGUAGE" != "auto" ] && lang_hint="The audio is in ${LANGUAGE}. "

  local prompt="${lang_hint}Transcribe this audio segment (chunk $((chunk_index+1)) of ${total_chunks}). Output the full transcript preserving speaker turns. Format:

**Speaker Name/Label:** text spoken...

Use Speaker 1, Speaker 2 etc if names unknown. Maintain original language. Add [MM:SS] timestamps at topic changes (relative to this chunk start)."

  local req_file="${TMPDIR_WORK}/req_${chunk_index}.json"
  cat > "$req_file" <<ENDJSON
{
  "contents": [{"parts": [
    {"text": $(echo "$prompt" | jq -Rs .)},
    {"file_data": {"mime_type": "${mime_type}", "file_uri": "${file_uri}"}}
  ]}],
  "generationConfig": {"temperature": 0.1, "maxOutputTokens": 32768}
}
ENDJSON

  local resp
  resp=$(curl -s --max-time 300 -X POST \
    "${GEMINI_CONTENT_URL}?key=${GEMINI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "@${req_file}" 2>&1)

  local err_msg
  err_msg=$(echo "$resp" | jq -r '.error.message // empty' 2>/dev/null)
  [ -n "$err_msg" ] && { echo "[Transcription error: ${err_msg}]"; return 0; }

  echo "$resp" | jq -r '.candidates[0].content.parts[0].text // "[No transcript for this chunk]"' 2>/dev/null
}

# ── Step 3: Upload and transcribe each chunk ───────────────────────────────────
FULL_TRANSCRIPT=""
CHUNK_INDEX=0
TOTAL_CHUNKS=$(echo "$CHUNK_FILES" | wc -w | tr -d ' ')

for chunk_file in $CHUNK_FILES; do
  CHUNK_INDEX_DISPLAY=$((CHUNK_INDEX + 1))
  echo "{\"status\":\"transcribing\",\"message\":\"Chunk ${CHUNK_INDEX_DISPLAY}/${TOTAL_CHUNKS}: uploading...\"}" >&2

  MIME=$(get_mime "$chunk_file")
  FILE_URI=$(upload_and_wait "$chunk_file" "$MIME")

  if [ -z "$FILE_URI" ]; then
    echo "{\"status\":\"error\",\"message\":\"Chunk ${CHUNK_INDEX_DISPLAY} upload/processing failed, skipping\"}" >&2
    FULL_TRANSCRIPT="${FULL_TRANSCRIPT}

---
[Chunk ${CHUNK_INDEX_DISPLAY} failed to process]
---
"
    CHUNK_INDEX=$((CHUNK_INDEX + 1))
    continue
  fi

  echo "{\"status\":\"transcribing\",\"message\":\"Chunk ${CHUNK_INDEX_DISPLAY}/${TOTAL_CHUNKS}: transcribing...\"}" >&2
  CHUNK_TEXT=$(transcribe_chunk "$FILE_URI" "$MIME" "$CHUNK_INDEX" "$TOTAL_CHUNKS")

  # Add time offset header for multi-chunk
  if [ "$TOTAL_CHUNKS" -gt 1 ]; then
    OFFSET_MINS=$(( CHUNK_INDEX * CHUNK_DURATION_SECONDS / 60 ))
    FULL_TRANSCRIPT="${FULL_TRANSCRIPT}

--- Segment ${CHUNK_INDEX_DISPLAY} (from ${OFFSET_MINS}:00) ---

${CHUNK_TEXT}"
  else
    FULL_TRANSCRIPT="$CHUNK_TEXT"
  fi

  CHUNK_INDEX=$((CHUNK_INDEX + 1))
  echo "{\"status\":\"transcribing\",\"message\":\"Chunk ${CHUNK_INDEX_DISPLAY}/${TOTAL_CHUNKS}: done.\"}" >&2
done

if [ -z "$FULL_TRANSCRIPT" ]; then
  echo '{"success":false,"error":"All chunks failed to transcribe"}'
  exit 1
fi

# ── Step 4: Output ─────────────────────────────────────────────────────────────
if [ -n "$OUTPUT_FILE" ]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  cat > "$OUTPUT_FILE" <<ENDMD
# ${TITLE}

> Source: ${URL:-local file}
> Transcribed: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
> Model: ${MODEL}
> Duration: ${DURATION_SECS}s (${TOTAL_CHUNKS} chunks)

---

${FULL_TRANSCRIPT}
ENDMD
  echo "{\"status\":\"saved\",\"message\":\"Transcript saved to ${OUTPUT_FILE}\"}" >&2
fi

TRANSCRIPT_LENGTH=${#FULL_TRANSCRIPT}
echo "{\"success\":true,\"title\":$(echo "$TITLE" | jq -Rs .),\"url\":$(echo "${URL:-}" | jq -Rs .),\"audioUrl\":$(echo "${AUDIO_URL:-}" | jq -Rs .),\"model\":\"${MODEL}\",\"duration\":${DURATION_SECS},\"chunks\":${TOTAL_CHUNKS},\"transcriptLength\":${TRANSCRIPT_LENGTH},\"transcript\":$(echo "$FULL_TRANSCRIPT" | jq -Rs .)}"
