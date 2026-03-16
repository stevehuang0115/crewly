---
name: Gemini Video Understanding
description: "Analyze videos using Google's Gemini API. Supports YouTube URLs (direct analysis) and local video files (upload via Files API). Produces summaries, key points, transcript highlights, and answers questions about video content."
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - developer
  - researcher
  - content
triggers:
  - analyze video
  - video summary
  - youtube analysis
  - video understanding
  - gemini video
tags:
  - video
  - analysis
  - youtube
  - gemini
  - ai
  - content
  - summary
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 300000
environment:
notices:
  - type: requirement
    message: This skill requires a Gemini API key. Add GEMINI_API_KEY to your environment.
---

# Gemini Video Understanding

Analyze video content using Google's Gemini API. Supports both YouTube URLs and local video files.

## Overview

This skill enables agents to understand video content by leveraging Gemini's multimodal capabilities. Use it for:

- Summarizing YouTube videos or local recordings
- Extracting key points and takeaways
- Getting transcript highlights and notable quotes
- Asking specific questions about video content
- Competitive analysis of video content

## Usage

### Analyze a YouTube Video

```bash
bash execute.sh '{"url": "https://youtu.be/VIDEO_ID", "prompt": "Summarize this video"}'
```

### Analyze a Local Video File

```bash
bash execute.sh '{"file": "/path/to/video.mp4", "prompt": "What are the key points?"}'
```

### Custom Prompt

```bash
bash execute.sh '{"url": "https://youtube.com/watch?v=xxx", "prompt": "List all technologies mentioned in this video"}'
```

### Use Advanced Model

```bash
bash execute.sh '{"url": "https://youtu.be/xxx", "prompt": "Detailed analysis", "model": "advanced"}'
```

### Save Output to File

```bash
bash execute.sh '{"url": "https://youtu.be/xxx", "prompt": "Full summary", "output": "/tmp/analysis.md"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url`     | Yes*     | YouTube URL to analyze |
| `file`    | Yes*     | Path to local video file (mp4, webm, mov, avi) |
| `prompt`  | No       | Custom analysis prompt (default: comprehensive summary) |
| `model`   | No       | `standard` (gemini-2.0-flash) or `advanced` (gemini-2.5-flash). Default: standard |
| `output`  | No       | File path to save the analysis output |

*One of `url` or `file` is required.

## API Configuration

Requires `GEMINI_API_KEY` environment variable. Get one at [Google AI Studio](https://aistudio.google.com/apikey).

## Supported Video Formats

- **YouTube:** Any public YouTube URL (youtu.be or youtube.com)
- **Local files:** MP4, WebM, MOV, AVI, MKV, FLV (max 2GB via Files API)

## Limitations

- YouTube analysis requires the video to be publicly accessible
- Local file upload may take time for large files (uploaded via Gemini Files API)
- Very long videos may hit token limits; consider using the advanced model
- Analysis quality depends on video/audio clarity
