---
name: xiaoyuzhoufm-transcript
description: Extract and transcribe 小宇宙 (Xiaoyuzhou FM) podcast episodes. Resolves an episode URL to its audio, then transcribes with Whisper via the transcribe-audio skill — local whisper.cpp by default (free, offline), OpenAI Whisper API as fallback. Segment-level timestamps.
category: content
assignableRoles:
  - "*"
version: "2.0.0"
tags:
  - podcast
  - transcript
  - audio
  - whisper
  - xiaoyuzhou
  - chinese
---

# 小宇宙 Podcast Transcript

Turn a 小宇宙 episode URL into a timestamped transcript.

## Pipeline

```
Episode URL → Fetch HTML → Extract audio URL → Download m4a
                                                    ↓
                                    transcribe-audio (Whisper) → Markdown + JSON
```

This skill owns the 小宇宙 half — resolving an episode page to its audio and
labelling the result. Transcription is delegated to the `transcribe-audio`
skill, so there is one Whisper integration in the repo rather than two, and
this skill inherits its engine selection, normalization and long-file handling
for free.

## Usage

```bash
# Transcribe from URL
bash execute.sh '{"url":"https://www.xiaoyuzhoufm.com/episode/69bbc8ea3c625cc5ae21b461"}'

# Save transcript to file
bash execute.sh '{"url":"https://www.xiaoyuzhoufm.com/episode/...","outputFile":"./transcripts/episode.md"}'

# Transcribe a local audio file (skip download)
bash execute.sh '{"audioFile":"/path/to/podcast.m4a"}'

# Language hint (ISO-639-1) — helps on mixed Chinese/English episodes
bash execute.sh '{"url":"...","language":"zh"}'

# Force an engine
bash execute.sh '{"url":"...","engine":"local"}'
bash execute.sh '{"url":"...","engine":"openai"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes* | 小宇宙 episode URL |
| `audioFile` | Yes* | Path to local audio file (alternative to url) |
| `outputFile` | No | Save transcript as markdown to this path |
| `language` | No | Language hint, ISO-639-1 (`zh`, `en`, `ja`…). Default: auto-detect |
| `engine` | No | `auto` (default), `local`, or `openai` — passed to `transcribe-audio` |

*Either `url` or `audioFile` is required.

## Output Format

```json
{
  "success": true,
  "title": "Episode Title",
  "url": "https://www.xiaoyuzhoufm.com/episode/...",
  "audioUrl": "https://media.xyzcdn.net/...",
  "engine": "whisper.cpp",
  "language": "zh",
  "duration": 4437,
  "transcriptLength": 41234,
  "transcript": "[00:00:00] ...\n[00:00:07] ..."
}
```

## Transcript Format

- One line per segment, prefixed `[HH:MM:SS]`
- Original language preserved (Chinese / English / mixed)

## Prerequisites

- `curl` and `jq` in PATH
- Whatever `transcribe-audio` needs: `ffmpeg`, plus either a local whisper.cpp
  install (`whisper-cli` + a `ggml-*` model) or `OPENAI_API_KEY` for the fallback
- Internet access to xiaoyuzhoufm.com (and to the OpenAI API only if the local
  engine is unavailable)

**No Gemini key is required.** On the default local path the transcription runs
entirely offline at zero per-use cost.

## Notes

- Episodes are typically 30–90 minutes (20–80 MB)
- Local whisper.cpp roughly tracks real time on Apple Silicon; a 75-minute
  episode takes on the order of ten minutes
- Temp files (page HTML, downloaded audio) are auto-cleaned on exit — including
  on interrupt, so a killed run leaves nothing behind and also keeps nothing
  to resume from
- **No speaker identification.** The previous Gemini-based version labelled
  speaker turns; Whisper does not do diarization, so output is timestamped
  segments only
