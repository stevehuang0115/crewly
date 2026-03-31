---
name: screenshot-compare
description: Compare two screenshots (e.g., iOS reference vs Web implementation) using Gemini Vision API. Returns a structured diff report with categorized issues, severity levels, and CSS fix suggestions. Use when verifying UI parity, checking design implementation accuracy, or auditing visual consistency across platforms.
category: qa
assignableRoles:
  - "*"
version: "1.0.0"
tags:
  - screenshot
  - visual-qa
  - comparison
  - gemini
  - parity
---

# Screenshot Compare

Compare two UI screenshots using Gemini Vision API and get a structured diff report.

## Actions

| Parameter | Required | Description |
|-----------|----------|-------------|
| `reference` | Yes | Path to the reference screenshot (source of truth, e.g., iOS app) |
| `target` | Yes | Path to the target screenshot (implementation to verify, e.g., web app) |
| `focus` | No | Comma-separated focus areas: `icons,layout,colors,text,images,spacing` (default: all) |
| `context` | No | Additional context (e.g., "This is the settings page", "Dark mode") |

## Usage

```bash
# Basic comparison
bash execute.sh '{"reference":"/path/to/ios-screenshot.png","target":"/path/to/web-screenshot.png"}'

# Focused comparison (only icons and colors)
bash execute.sh '{"reference":"ref.png","target":"web.png","focus":"icons,colors"}'

# With context
bash execute.sh '{"reference":"ios-home.png","target":"web-home.png","context":"Home screen, light mode"}'
```

## Output Format

Returns JSON with:
- `matchScore` — 0-100 overall similarity score
- `totalIssues` — count of differences found
- `issues[]` — array of categorized differences:
  - `type` — icon_missing, layout_shift, color_mismatch, text_mismatch, font_mismatch, spacing, etc.
  - `severity` — critical, major, minor
  - `element` — which UI element is affected
  - `suggestion` — specific CSS/code fix

## Issue Types

| Type | Description |
|------|-------------|
| `icon_missing` | Icon present in reference but missing in target |
| `icon_wrong` | Icon exists but is the wrong icon |
| `layout_shift` | Elements positioned differently |
| `spacing` | Padding/margin differences |
| `color_mismatch` | Colors don't match between reference and target |
| `text_mismatch` | Text content differs |
| `font_mismatch` | Font family, size, or weight differs |
| `image_missing` | Image present in reference but missing/broken in target |
| `image_wrong` | Image exists but is different |
| `border_radius` | Rounded corners differ |
| `shadow` | Box shadow differences |
| `alignment` | Vertical/horizontal alignment issues |
| `responsive` | Layout doesn't adapt correctly |

## Prerequisites

- `GEMINI_API_KEY` environment variable or configured in Settings > API Keys
- Both image files must exist and be PNG, JPG, GIF, or WebP
- Images should be under 4MB each
