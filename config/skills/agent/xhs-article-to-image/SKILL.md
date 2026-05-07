---
name: xhs-article-to-image
description: Convert markdown articles into XiaoHongShu (小红书) style portrait image cards (1080×1440 PNGs) for social distribution.
version: 1.0.0
category: content
skillType: claude-skill
tags:
  - content
  - image
  - xhs
  - marketing
  - playwright
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# xhs-article-to-image

Convert markdown articles into XiaoHongShu (小红书) style image cards.

## Description

Generates multiple PNG images (1080×1440, 3:4 portrait ratio) from markdown article content, styled in the popular XiaoHongShu magazine-layout format: bold titles, clean white backgrounds, structured paragraphs with visual hierarchy.

## Usage

```bash
bash execute.sh '{"content":"# Title\n\nArticle body...","outputDir":"/tmp/xhs-output"}'
```

Or from a file:
```bash
bash execute.sh '{"sourceFile":"/path/to/article.md","outputDir":"/tmp/xhs-output"}'
```

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| content | Yes* | - | Markdown article content (required if no sourceFile) |
| sourceFile | Yes* | - | Path to markdown file (required if no content) |
| outputDir | Yes | - | Directory to write PNG images to |
| title | No | auto | Override the article title (auto-extracts from first H1) |
| author | No | "" | Author name shown at bottom of pages |
| accentColor | No | "#1a1a1a" | Accent color for decorative elements |
| bgColor | No | "#fafaf8" | Background color |
| maxCharsPerPage | No | 350 | Approximate characters per page before splitting |
| coverImage | No | "" | URL or path to image for the cover page |

## Output

- Multiple PNG files: `page-01.png`, `page-02.png`, etc.
- First page is the title/cover page
- Returns JSON with file paths and metadata

## Dependencies

- Node.js 18+
- Playwright (chromium)

## Style Features

- 3:4 portrait ratio (1080×1440px) optimized for XHS
- Bold sans-serif Chinese/English typography (Noto Sans SC)
- Clean white/cream background with subtle decorative elements
- Magazine-style paragraph layout with visual breathing room
- Page numbering (current/total)
- Optional author attribution
