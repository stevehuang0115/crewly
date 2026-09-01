#!/bin/bash
# 小宇宙 Podcast Transcript — fetch an episode and transcribe it.
#
# Pipeline: URL → HTML → audio URL → download → transcribe-audio (Whisper)
#
# This skill owns the 小宇宙 part: resolving an episode URL to its audio and
# labelling the result. Transcription itself is delegated to the
# `transcribe-audio` skill, so there is exactly one Whisper integration in the
# repo to maintain and this skill inherits its engine selection (local
# whisper.cpp by default, OpenAI Whisper API as fallback).
#
# Usage:
#   bash execute.sh '{"url":"https://www.xiaoyuzhoufm.com/episode/69bbc8ea3c625cc5ae21b461"}'
#   bash execute.sh '{"url":"...","outputFile":"/path/to/transcript.md"}'
#   bash execute.sh '{"audioFile":"/path/to/local.m4a"}'
#   bash execute.sh '{"url":"...","engine":"openai"}'
#
# Requires: curl, jq, and whatever `transcribe-audio` needs (ffmpeg + a Whisper
# engine). No API key is needed on the default local path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRANSCRIBE_SKILL="${SCRIPT_DIR}/../transcribe-audio/execute.sh"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# ── Input parsing ──────────────────────────────────────────────────────────────
INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  echo '{"success":false,"error":"Usage: execute.sh '{\"url\":\"https://www.xiaoyuzhoufm.com/episode/...\"}'"}'
  exit 1
fi

URL=$(printf '%s' "$INPUT" | jq -r '.url // empty')
AUDIO_FILE=$(printf '%s' "$INPUT" | jq -r '.audioFile // empty')
OUTPUT_FILE=$(printf '%s' "$INPUT" | jq -r '.outputFile // empty')
LANGUAGE=$(printf '%s' "$INPUT" | jq -r '.language // "auto"')
ENGINE=$(printf '%s' "$INPUT" | jq -r '.engine // "auto"')

if [ -z "$URL" ] && [ -z "$AUDIO_FILE" ]; then
  echo '{"success":false,"error":"Either url or audioFile is required"}'
  exit 1
fi

if [ ! -f "$TRANSCRIBE_SKILL" ]; then
  echo "{\"success\":false,\"error\":$(printf '%s' "transcribe-audio skill not found at ${TRANSCRIBE_SKILL}" | jq -Rs .)}"
  exit 1
fi

# ── Temp directory with auto-cleanup ───────────────────────────────────────────
TMPDIR_WORK=$(mktemp -d /tmp/xiaoyuzhoufm-XXXXXX)
cleanup() { rm -rf "$TMPDIR_WORK"; }
trap cleanup EXIT

# ── Step 1: Resolve the episode URL to a downloadable audio file ───────────────
TITLE="Unknown Episode"
AUDIO_URL=""
DOWNLOADED=0

if [ -n "$URL" ] && [ -z "$AUDIO_FILE" ]; then
  echo '{"status":"fetching","message":"Fetching episode page..."}' >&2

  HTML_FILE="${TMPDIR_WORK}/page.html"
  curl -sL -o "$HTML_FILE" -H "$UA" "$URL" 2>/dev/null || true

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

  echo "{\"status\":\"downloading\",\"message\":\"Downloading audio...\",\"title\":$(printf '%s' "$TITLE" | jq -Rs .)}" >&2

  AUDIO_FILE="${TMPDIR_WORK}/audio.m4a"
  curl -sL -o "$AUDIO_FILE" -H "$UA" "$AUDIO_URL"
  DOWNLOADED=1

  if [ ! -s "$AUDIO_FILE" ]; then
    echo '{"success":false,"error":"Audio download produced an empty file"}'
    exit 1
  fi
  echo "{\"status\":\"downloaded\",\"message\":\"Audio downloaded ($(wc -c < "$AUDIO_FILE" | tr -d ' ') bytes)\"}" >&2
else
  if [ ! -f "$AUDIO_FILE" ]; then
    echo "{\"success\":false,\"error\":$(printf '%s' "Audio file not found: ${AUDIO_FILE}" | jq -Rs .)}"
    exit 1
  fi
  TITLE=$(basename "$AUDIO_FILE")
fi

# ── Step 2: Transcribe via the shared Whisper skill ────────────────────────────
# The inner skill emits progress on stderr (passed through) and its result JSON
# on stdout. It handles normalization, engine selection and long-file chunking,
# so none of that is duplicated here.
echo '{"status":"transcribing","message":"Handing off to transcribe-audio (Whisper)..."}' >&2

TRANSCRIBE_IN=$(jq -nc \
  --arg audioFile "$AUDIO_FILE" \
  --arg language "$LANGUAGE" \
  --arg engine "$ENGINE" \
  '{audioFile:$audioFile, language:$language, engine:$engine}')

RESULT_JSON=$(bash "$TRANSCRIBE_SKILL" "$TRANSCRIBE_IN") || {
  echo '{"success":false,"error":"transcribe-audio failed — see stderr for the engine error"}'
  exit 1
}

if [ "$(printf '%s' "$RESULT_JSON" | jq -r '.success // false')" != "true" ]; then
  ERR=$(printf '%s' "$RESULT_JSON" | jq -r '.error // "transcribe-audio reported failure"')
  echo "{\"success\":false,\"error\":$(printf '%s' "$ERR" | jq -Rs .)}"
  exit 1
fi

ENGINE_LABEL=$(printf '%s' "$RESULT_JSON" | jq -r '.engine // "whisper"')
LANG_OUT=$(printf '%s' "$RESULT_JSON" | jq -r '.language // "unknown"')
DURATION=$(printf '%s' "$RESULT_JSON" | jq -r '.durationSec // 0')
FULL_TEXT=$(printf '%s' "$RESULT_JSON" | jq -r '.text // ""')

if [ -z "$FULL_TEXT" ]; then
  echo '{"success":false,"error":"Transcription returned no text"}'
  exit 1
fi

# Segment lines with HH:MM:SS stamps — easier to scan in a 90-minute episode
# than the raw seconds the inner skill emits.
TRANSCRIPT_BODY=$(printf '%s' "$RESULT_JSON" | jq -r '
  (.segments // [])[]
  | (.start | floor) as $s
  | "[\($s / 3600 | floor | tostring | if length < 2 then "0" + . else . end):" +
    "\(($s % 3600) / 60 | floor | tostring | if length < 2 then "0" + . else . end):" +
    "\($s % 60 | tostring | if length < 2 then "0" + . else . end)] \(.text)"
')
[ -z "$TRANSCRIPT_BODY" ] && TRANSCRIPT_BODY="$FULL_TEXT"

# ── Step 3: Output ─────────────────────────────────────────────────────────────
if [ -n "$OUTPUT_FILE" ]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  cat > "$OUTPUT_FILE" <<ENDMD
# ${TITLE}

> Source: ${URL:-local file}
> Transcribed: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
> Engine: ${ENGINE_LABEL} (language: ${LANG_OUT})
> Duration: ${DURATION}s

---

${TRANSCRIPT_BODY}
ENDMD
  echo "{\"status\":\"saved\",\"message\":$(printf '%s' "Transcript saved to ${OUTPUT_FILE}" | jq -Rs .)}" >&2
fi

printf '%s' "$RESULT_JSON" | jq -c \
  --arg title "$TITLE" \
  --arg url "${URL:-}" \
  --arg audioUrl "${AUDIO_URL:-}" \
  --arg transcript "$TRANSCRIPT_BODY" \
  '{success:true, title:$title, url:$url, audioUrl:$audioUrl,
    engine:.engine, language:.language, duration:.durationSec,
    transcriptLength:($transcript | length), transcript:$transcript}'
