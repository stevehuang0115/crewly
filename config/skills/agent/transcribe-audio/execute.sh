#!/bin/bash
# transcribe-audio — General-purpose Whisper speech-to-text for a local file.
#
# Engines:
#   local  : whisper.cpp (large-v3-turbo) — free, offline, segment timestamps.
#   openai : OpenAI Whisper API (whisper-1) — zero-install, pay-per-use.
#   auto   : prefer local if installed, else fall back to openai (default).
#
# Engine detection + key resolution lift the proven logic from Flopost
# (desktop/server/whisperModule.ts, service/lib/video/transcriptionService.ts).
#
# Usage:
#   bash execute.sh '{"audioFile":"/path/to/recording.m4a"}'
#   bash execute.sh '{"audioFile":"/x.mp3","outputFile":"./t.md","language":"zh"}'
#   bash execute.sh '{"audioFile":"/x.wav","engine":"openai"}'
#
# Requires: ffmpeg, jq, curl. Local engine also needs whisper-cli + a model file.

set -euo pipefail

# ── Constants (no hardcoded magic spread through the body) ───────────────────────
MODEL_FILENAME="ggml-large-v3-turbo-q5_0.bin"
FLOPOST_WHISPER_DIR="${HOME}/.flopost/whisper"
WHISPER_CACHE_DIR="${HOME}/.cache/whisper-models"
OPENAI_TRANSCRIBE_URL="https://api.openai.com/v1/audio/transcriptions"
OPENAI_MODEL="whisper-1"
SETTINGS_URL="http://localhost:8787/api/settings"

err_json() { printf '{"success":false,"error":%s}\n' "$(printf '%s' "$1" | jq -Rsa .)"; exit 1; }

# ── Input parsing ───────────────────────────────────────────────────────────────
INPUT="${1:-}"
[ -z "$INPUT" ] && err_json "Usage: execute.sh '{\"audioFile\":\"/path/to/audio.m4a\"}'"

command -v jq >/dev/null 2>&1 || { echo '{"success":false,"error":"jq is required but not installed (brew install jq)"}'; exit 1; }

AUDIO_FILE=$(printf '%s' "$INPUT" | jq -r '.audioFile // empty')
OUTPUT_FILE=$(printf '%s' "$INPUT" | jq -r '.outputFile // empty')
LANGUAGE=$(printf '%s' "$INPUT" | jq -r '.language // "auto"')
ENGINE=$(printf '%s' "$INPUT" | jq -r '.engine // "auto"')

[ -z "$AUDIO_FILE" ] && err_json "audioFile is required (path to a local audio or video file)"
[ -f "$AUDIO_FILE" ] || err_json "audioFile not found: ${AUDIO_FILE}"
case "$ENGINE" in auto|local|openai) ;; *) err_json "engine must be one of: auto, local, openai (got: ${ENGINE})";; esac

command -v ffmpeg >/dev/null 2>&1 || err_json "ffmpeg is required but not installed (brew install ffmpeg)"

# ── Local whisper.cpp detection (lifted from whisperModule.ts) ───────────────────
resolve_whisper_binary() {
  if [ -n "${FLOPOST_WHISPER_BIN:-}" ] && [ -x "${FLOPOST_WHISPER_BIN}" ]; then echo "${FLOPOST_WHISPER_BIN}"; return; fi
  if [ -x "${FLOPOST_WHISPER_DIR}/whisper-cli" ]; then echo "${FLOPOST_WHISPER_DIR}/whisper-cli"; return; fi
  if command -v whisper-cli >/dev/null 2>&1; then command -v whisper-cli; return; fi
  for p in /opt/homebrew/bin/whisper-cli /usr/local/bin/whisper-cli; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  echo ""
}
resolve_whisper_model() {
  if [ -n "${FLOPOST_WHISPER_MODEL:-}" ] && [ -f "${FLOPOST_WHISPER_MODEL}" ]; then echo "${FLOPOST_WHISPER_MODEL}"; return; fi
  if [ -f "${FLOPOST_WHISPER_DIR}/${MODEL_FILENAME}" ]; then echo "${FLOPOST_WHISPER_DIR}/${MODEL_FILENAME}"; return; fi
  if [ -f "${WHISPER_CACHE_DIR}/${MODEL_FILENAME}" ]; then echo "${WHISPER_CACHE_DIR}/${MODEL_FILENAME}"; return; fi
  echo ""
}
binary_hint() {
  case "$(uname -s)" in
    Darwin) echo "brew install whisper-cpp" ;;
    *) echo "Build whisper.cpp from https://github.com/ggerganov/whisper.cpp and put whisper-cli on PATH" ;;
  esac
}

WHISPER_BIN="$(resolve_whisper_binary)"
WHISPER_MODEL="$(resolve_whisper_model)"
LOCAL_AVAILABLE=false
[ -n "$WHISPER_BIN" ] && [ -n "$WHISPER_MODEL" ] && LOCAL_AVAILABLE=true

# ── OpenAI key resolution (env → Crewly settings; never hardcoded) ───────────────
resolve_openai_key() {
  if [ -n "${OPENAI_API_KEY:-}" ]; then echo "${OPENAI_API_KEY}"; return; fi
  curl -sf "${SETTINGS_URL}" 2>/dev/null | jq -r '.data.apiKeys.global.openai // empty' 2>/dev/null || true
}

# ── Choose engine ────────────────────────────────────────────────────────────────
CHOSEN=""
if [ "$ENGINE" = "local" ]; then
  [ "$LOCAL_AVAILABLE" = true ] || err_json "engine=local requested but whisper.cpp is not installed. Binary: $( [ -n "$WHISPER_BIN" ] && echo found || echo "missing ($(binary_hint))" ); Model: $( [ -n "$WHISPER_MODEL" ] && echo found || echo "missing ${MODEL_FILENAME} (put it in ${FLOPOST_WHISPER_DIR}/ or set FLOPOST_WHISPER_MODEL)" )."
  CHOSEN="local"
elif [ "$ENGINE" = "openai" ]; then
  CHOSEN="openai"
else
  if [ "$LOCAL_AVAILABLE" = true ]; then CHOSEN="local"; else CHOSEN="openai"; fi
fi

# ── Working dir with auto-cleanup ────────────────────────────────────────────────
WORK=$(mktemp -d /tmp/transcribe-audio-XXXXXX)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Normalize to 16kHz mono PCM WAV (what both engines want).
WAV="${WORK}/audio.wav"
echo '{"status":"extracting","message":"Normalizing audio to 16kHz mono WAV..."}' >&2
if ! ffmpeg -y -i "$AUDIO_FILE" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$WAV" >/dev/null 2>"${WORK}/ffmpeg.err"; then
  err_json "ffmpeg failed to extract audio: $(tail -c 400 "${WORK}/ffmpeg.err" 2>/dev/null)"
fi

# Duration (best-effort).
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$WAV" 2>/dev/null || echo "null")
[ -z "$DURATION" ] && DURATION="null"

RESULT_FILE="${WORK}/result.json"   # holds {language, segments:[{start,end,text,speaker}]}
# Engine functions write RESULT_FILE on success, return non-zero (with message in
# engine.err) on failure — never exit, so auto-mode can fall back cleanly.
fail() { printf '%s' "$1" > "${WORK}/engine.err"; return 1; }

# ── Engine: local whisper.cpp ────────────────────────────────────────────────────
run_local() {
  echo "{\"status\":\"transcribing\",\"engine\":\"whisper.cpp\",\"message\":\"Running local whisper.cpp...\"}" >&2
  local prefix="${WORK}/out"
  local lang_arg="auto"; [ "$LANGUAGE" != "auto" ] && lang_arg="$LANGUAGE"
  local threads; threads=$(( $(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4) - 2 )); [ "$threads" -lt 4 ] && threads=4
  if ! "$WHISPER_BIN" -m "$WHISPER_MODEL" -f "$WAV" -l "$lang_arg" -oj -of "$prefix" -t "$threads" >/dev/null 2>"${WORK}/whisper.err"; then
    fail "whisper-cli failed: $(tail -c 400 "${WORK}/whisper.err" 2>/dev/null)"; return 1
  fi
  [ -f "${prefix}.json" ] || { fail "whisper-cli produced no JSON output"; return 1; }
  # whisper.cpp JSON: { result:{language}, transcription:[{offsets:{from,to(ms)}, text}] }
  jq '{
    language: (.result.language // "auto"),
    segments: [ .transcription[]
      | { start: ((.offsets.from // 0) / 1000),
          end:   ((.offsets.to   // 0) / 1000),
          text:  (.text | gsub("^[[:space:]]+|[[:space:]]+$";"")),
          speaker: "Unknown" }
      | select(.text | test("^\\[.*\\]$") | not)   # drop [BLANK_AUDIO] / [Music] tags
      | select(.text | length > 0) ]
  }' "${prefix}.json" > "$RESULT_FILE" || { fail "failed to parse whisper.cpp output"; return 1; }
  return 0
}

# ── Engine: OpenAI Whisper API ───────────────────────────────────────────────────
run_openai() {
  local key; key="$(resolve_openai_key)"
  [ -z "$key" ] && { fail "OpenAI engine selected but no OpenAI API key found. Set OPENAI_API_KEY (Crewly secrets) or configure Settings > API Keys."; return 1; }
  echo "{\"status\":\"transcribing\",\"engine\":\"openai-whisper-1\",\"message\":\"Uploading to OpenAI Whisper API...\"}" >&2
  local resp="${WORK}/openai.json"
  local lang_args=(); [ "$LANGUAGE" != "auto" ] && lang_args=(-F "language=${LANGUAGE}")
  local http
  http=$(curl -sS -w '%{http_code}' -o "$resp" \
    -X POST "$OPENAI_TRANSCRIBE_URL" \
    -H "Authorization: Bearer ${key}" \
    -F "file=@${WAV};type=audio/wav" \
    -F "model=${OPENAI_MODEL}" \
    -F "response_format=verbose_json" \
    -F "timestamp_granularities[]=segment" \
    "${lang_args[@]}" 2>"${WORK}/curl.err" || echo "000")
  if [ "$http" != "200" ]; then
    local apierr; apierr=$(jq -r '.error.message // empty' "$resp" 2>/dev/null || true)
    fail "OpenAI Whisper API error (HTTP ${http}): ${apierr:-$(tail -c 300 "$resp" 2>/dev/null)}"; return 1
  fi
  jq '{
    language: (.language // "auto"),
    segments: [ (.segments // [])[]
      | { start: (.start // 0),
          end:   (.end   // 0),
          text:  ((.text // "") | gsub("^[[:space:]]+|[[:space:]]+$";"")),
          speaker: "Unknown" }
      | select(.text | length > 0) ]
  }' "$resp" > "$RESULT_FILE" || { fail "failed to parse OpenAI output"; return 1; }
  return 0
}

# Run chosen engine; auto-mode falls back local→openai on local failure.
if [ "$CHOSEN" = "local" ]; then
  if run_local; then
    :
  elif [ "$ENGINE" = "auto" ]; then
    echo '{"status":"fallback","message":"Local engine failed; falling back to OpenAI..."}' >&2
    CHOSEN="openai"
    run_openai || err_json "$(cat "${WORK}/engine.err" 2>/dev/null)"
  else
    err_json "$(cat "${WORK}/engine.err" 2>/dev/null)"
  fi
else
  run_openai || err_json "$(cat "${WORK}/engine.err" 2>/dev/null)"
fi

[ -f "$RESULT_FILE" ] || err_json "Transcription produced no result"
RESULT_JSON=$(cat "$RESULT_FILE")

ENGINE_LABEL="whisper.cpp"; [ "$CHOSEN" = "openai" ] && ENGINE_LABEL="openai-whisper-1"
FULL_TEXT=$(printf '%s' "$RESULT_JSON" | jq -r '[.segments[].text] | join(" ")')
LANG_OUT=$(printf '%s' "$RESULT_JSON" | jq -r '.language')
SEG_COUNT=$(printf '%s' "$RESULT_JSON" | jq '.segments | length')

# ── Optional output file (Markdown or JSON by extension) ─────────────────────────
SAVED_PATH=""
if [ -n "$OUTPUT_FILE" ]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")" 2>/dev/null || true
  case "$OUTPUT_FILE" in
    *.json)
      printf '%s' "$RESULT_JSON" | jq --arg engine "$ENGINE_LABEL" --argjson dur "$DURATION" \
        '{engine:$engine, language:.language, durationSec:$dur, segments:.segments}' > "$OUTPUT_FILE"
      ;;
    *)
      {
        printf '# Transcript\n\n'
        printf -- '- **Engine:** %s\n- **Language:** %s\n- **Duration:** %ss\n\n' "$ENGINE_LABEL" "$LANG_OUT" "$DURATION"
        printf '## Full Text\n\n%s\n\n## Segments\n\n' "$FULL_TEXT"
        printf '%s' "$RESULT_JSON" | jq -r '.segments[] | "- [\(.start | (. * 100 | round / 100))s → \(.end | (. * 100 | round / 100))s] \(.text)"'
      } > "$OUTPUT_FILE"
      ;;
  esac
  SAVED_PATH="$OUTPUT_FILE"
fi

# ── Final JSON to stdout ─────────────────────────────────────────────────────────
printf '%s' "$RESULT_JSON" | jq \
  --arg engine "$ENGINE_LABEL" \
  --arg text "$FULL_TEXT" \
  --argjson dur "$DURATION" \
  --argjson segCount "$SEG_COUNT" \
  --arg saved "$SAVED_PATH" \
  '{ success:true, engine:$engine, language:.language, durationSec:$dur,
     text:$text, segments:.segments, segmentCount:$segCount }
   + (if $saved == "" then {} else {outputFile:$saved} end)'
