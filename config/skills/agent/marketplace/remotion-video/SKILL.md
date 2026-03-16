---
name: Remotion Video Generator
description: Generate motion graphic videos programmatically using Remotion and React. Supports template-based video creation with customizable text, colors, images, and transitions. Renders to MP4 locally.
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - developer
  - designer
  - content
  - generalist
  - product-manager
triggers:
  - create video
  - generate video
  - motion graphics
  - remotion
  - launch video
  - promo video
  - video animation
tags:
  - video
  - remotion
  - react
  - motion-graphics
  - animation
  - mp4
  - content
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 600000
environment:
notices:
  - type: requirement
    message: Remotion requires Node.js 18 or later. First run will install dependencies (~400MB).
---

# Remotion Video Generator

Generate motion graphic videos programmatically using Remotion and React.

## Overview

This skill creates videos from structured input using pre-built templates. It manages a Remotion workspace automatically and renders MP4 videos locally. No external API keys needed.

## Usage

### Quick Start — Launch Video

```bash
bash execute.sh '{
  "template": "launch",
  "props": {
    "title": "Crewly",
    "subtitle": "One Person, One AI Team",
    "features": ["AI Agents", "Skill Marketplace", "Auto-Orchestration"],
    "bgColor": "#0f172a",
    "accentColor": "#3b82f6",
    "textColor": "#ffffff"
  },
  "output": "/tmp/crewly-launch.mp4"
}'
```

### Text Slides Video

```bash
bash execute.sh '{
  "template": "text-slides",
  "props": {
    "slides": [
      {"title": "Welcome", "body": "Introducing our new product"},
      {"title": "Features", "body": "AI-powered, fast, reliable"},
      {"title": "Get Started", "body": "Visit crewly.dev today"}
    ],
    "bgColor": "#1a1a2e",
    "accentColor": "#e94560",
    "textColor": "#ffffff"
  },
  "output": "/tmp/slides.mp4"
}'
```

### Announcement Video

```bash
bash execute.sh '{
  "template": "announcement",
  "props": {
    "headline": "Version 2.0 is Here!",
    "body": "Faster, smarter, and more powerful than ever.",
    "cta": "Download Now",
    "bgColor": "#0a0a0a",
    "accentColor": "#22c55e",
    "textColor": "#ffffff"
  },
  "output": "/tmp/announcement.mp4"
}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `template` | Yes | Template name: `launch`, `text-slides`, `announcement` |
| `props` | Yes | Template-specific properties (see below) |
| `output` | No | Output file path (default: /tmp/remotion-output.mp4) |
| `duration` | No | Duration in seconds (default: template-dependent) |
| `width` | No | Video width in px (default: 1920) |
| `height` | No | Video height in px (default: 1080) |
| `fps` | No | Frames per second (default: 30) |

## Template Properties

### `launch` Template
| Prop | Type | Description |
|------|------|-------------|
| `title` | string | Product/company name |
| `subtitle` | string | Tagline or description |
| `features` | string[] | List of feature highlights (max 5) |
| `bgColor` | string | Background color (hex) |
| `accentColor` | string | Accent/highlight color (hex) |
| `textColor` | string | Text color (hex) |

### `text-slides` Template
| Prop | Type | Description |
|------|------|-------------|
| `slides` | array | Array of {title, body} objects |
| `bgColor` | string | Background color (hex) |
| `accentColor` | string | Accent color (hex) |
| `textColor` | string | Text color (hex) |

### `announcement` Template
| Prop | Type | Description |
|------|------|-------------|
| `headline` | string | Main announcement text |
| `body` | string | Supporting details |
| `cta` | string | Call to action text |
| `bgColor` | string | Background color (hex) |
| `accentColor` | string | Accent color (hex) |
| `textColor` | string | Text color (hex) |

## First Run

The first execution takes 2-5 minutes to set up the workspace at `~/.crewly/remotion-workspace/`. Subsequent runs are fast (10-30 seconds for a 15-second video).

## Limitations

- Templates only — no arbitrary video generation in v1
- Motion graphics (text, shapes, gradients) — no AI-generated imagery
- Local rendering only — no cloud/serverless rendering
- Requires ~400MB disk space for workspace
- Rendering time: ~1-2x video duration
