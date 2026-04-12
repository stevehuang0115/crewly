---
name: xiaoyuzhoufm-transcript
description: Extract and transcribe 小宇宙 (Xiaoyuzhou FM) podcast episodes. Downloads audio from episode URL and uses Gemini Audio API for transcription with speaker identification and timestamps.
category: content
assignableRoles:
  - "*"
version: "1.0.0"
tags:
  - podcast
  - transcript
  - audio
  - gemini
  - xiaoyuzhou
  - chinese
---

# 小宇宙 Podcast Transcript

Extract and transcribe podcast episodes from 小宇宙 (Xiaoyuzhou FM) using Gemini Audio API.

## Pipeline

```
Episode URL → Fetch HTML → Extract audio URL → Download m4a → Upload to Gemini → Transcribe → Output
```

## Usage

```bash
# Transcribe from URL
bash execute.sh '{"url":"https://www.xiaoyuzhoufm.com/episode/69bbc8ea3c625cc5ae21b461"}'

# Save transcript to file
bash execute.sh '{"url":"https://www.xiaoyuzhoufm.com/episode/...","outputFile":"./transcripts/episode.md"}'

# Transcribe a local audio file (skip download)
bash execute.sh '{"audioFile":"/path/to/podcast.m4a"}'

# Specify language hint
bash execute.sh '{"url":"...","language":"Chinese"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes* | 小宇宙 episode URL |
| `audioFile` | Yes* | Path to local audio file (alternative to url) |
| `outputFile` | No | Save transcript as markdown to this path |
| `language` | No | Language hint for Gemini (default: auto-detect) |

*Either `url` or `audioFile` is required.

## Output Format

```json
{
  "success": true,
  "title": "Episode Title",
  "url": "https://www.xiaoyuzhoufm.com/episode/...",
  "audioUrl": "https://media.xyzcdn.net/.../audio.m4a",
  "model": "gemini-2.5-flash-preview-05-20",
  "transcriptLength": 12345,
  "transcript": "**Speaker 1:** [00:00:00] Welcome to the show..."
}
```

## Transcript Format

- Speaker turns identified with `**Speaker Name:** text`
- Timestamps at segment/topic changes: `[HH:MM:SS]`
- Preserves original language (Chinese/English/mixed)

## Prerequisites

- `GEMINI_API_KEY` environment variable or configured in Settings > API Keys
- `curl` and `jq` available in PATH
- Internet access to xiaoyuzhoufm.com and Gemini API

## Notes

- Audio files are typically 30-90 minutes (20-80 MB)
- Gemini processing takes 30-120 seconds depending on audio length
- Maximum wait time: 5 minutes for Gemini processing
- Temp files are auto-cleaned on exit
