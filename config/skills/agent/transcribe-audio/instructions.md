# Transcribe Audio (Whisper)

Transcribe a **local audio or video file** into text with timestamps. This is the
general-purpose Whisper-based speech-to-text skill — distinct from
`xiaoyuzhoufm-transcript` (which is the Gemini-based podcast/video research skill;
this skill does **not** replace it).

## Engines

| Engine | When used | Cost | Network | Timestamps |
|--------|-----------|------|---------|------------|
| **whisper.cpp** (local, `large-v3-turbo`) | Default — used whenever the binary + model are present | Free | Offline | Segment + word-level |
| **OpenAI Whisper API** (`whisper-1`) | Fallback — used when local is unavailable, or forced via `engine:"openai"` | ~$0.006/min | Required | Segment + word-level |

**Default = `auto`:** prefer local whisper.cpp (free, private, offline, no per-use
cost — ideal for unattended agents), and transparently fall back to the OpenAI API
when the local engine is not installed. This gives zero-cost transcription where the
local model exists and zero-install reliability everywhere else. Force a specific
engine with `engine:"local"` or `engine:"openai"`.

## Usage

```bash
# Auto engine (local if available, else OpenAI). Prints JSON to stdout.
bash execute.sh '{"audioFile":"/path/to/recording.m4a"}'

# Save as Markdown (timestamped transcript)
bash execute.sh '{"audioFile":"/path/to/recording.mp3","outputFile":"./transcript.md"}'

# Save as JSON (full structured segments)
bash execute.sh '{"audioFile":"/path/to/recording.wav","outputFile":"./transcript.json"}'

# Language hint (ISO-639-1, e.g. en / zh / ja). Default: auto-detect
bash execute.sh '{"audioFile":"/path/to/recording.m4a","language":"zh"}'

# Force a specific engine
bash execute.sh '{"audioFile":"/path/to/x.wav","engine":"local"}'
bash execute.sh '{"audioFile":"/path/to/x.wav","engine":"openai"}'

# A video file works too — the audio track is extracted automatically
bash execute.sh '{"audioFile":"/path/to/clip.mp4"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `audioFile` | Yes | Path to a local audio or video file (m4a, mp3, wav, aac, ogg, flac, mp4, mov…) |
| `outputFile` | No | Save the transcript to this path. `.json` → structured JSON; anything else → Markdown |
| `language` | No | Language hint (ISO-639-1). Default: auto-detect |
| `engine` | No | `auto` (default), `local`, or `openai` |

## Output (stdout JSON)

```json
{
  "success": true,
  "engine": "whisper.cpp",
  "language": "en",
  "durationSec": 11.0,
  "text": "Full transcript as one block of text...",
  "segments": [
    { "start": 0.0, "end": 2.5, "text": "Hello everyone", "speaker": "Unknown" }
  ],
  "segmentCount": 1,
  "outputFile": "/abs/path/transcript.md"
}
```

`speaker` is `"Unknown"` unless the chosen engine returns diarization (neither
default engine performs speaker separation today; the field is reserved so
downstream consumers have a stable shape).

## Dependencies & Setup

- **`ffmpeg`** — required for both engines (audio is normalized to 16 kHz mono WAV).
  Install: `brew install ffmpeg`.
- **Local engine (`whisper.cpp`)** — needs the `whisper-cli` binary and a model file:
  - Binary: `brew install whisper-cpp` (provides `whisper-cli`). Override with `FLOPOST_WHISPER_BIN`.
  - Model: `ggml-large-v3-turbo-q5_0.bin` in `~/.flopost/whisper/` or `~/.cache/whisper-models/`. Override with `FLOPOST_WHISPER_MODEL`.
  - If the binary or model is missing, the skill falls back to OpenAI (or reports a clear hint when `engine:"local"` is forced).
- **OpenAI engine** — needs an OpenAI API key. Resolution order:
  1. `OPENAI_API_KEY` environment variable (injected by Crewly secrets).
  2. Crewly Settings → API Keys (`GET http://localhost:8787/api/settings` → `data.apiKeys.global.openai`).
  No key is ever hard-coded.

## Notes

- Engine detection and key resolution lift the proven logic from Flopost
  (`desktop/server/whisperModule.ts` and `service/lib/video/transcriptionService.ts`).
- Long files: whisper.cpp handles arbitrary length locally. The OpenAI API enforces a
  25 MB upload limit; for larger files prefer the local engine.
