---
name: Generate PDF
description: Convert a Markdown file to a styled PDF with full CJK (Chinese/Japanese/Korean) font support. Uses pandoc for Markdown→HTML and weasyprint for HTML→PDF rendering.
version: 1.0.0
category: document
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
  - content-strategist
triggers:
  - generate pdf
  - convert to pdf
  - create pdf
  - markdown to pdf
  - make pdf
tags:
  - pdf
  - document
  - markdown
  - pandoc
  - weasyprint
  - cjk
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Generate PDF

Convert a Markdown file to a professionally styled PDF with full CJK (Chinese/Japanese/Korean) font support.

## Pipeline

1. **Markdown → HTML**: Uses `pandoc` with `--standalone` and an inline CJK-compatible CSS header
2. **HTML → PDF**: Uses `weasyprint` (NOT Chrome headless, which cannot render CJK characters)

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `input` | Yes | Path to the input Markdown file |
| `output` | No | Path for the output PDF file (defaults to input path with `.pdf` extension) |
| `title` | No | Document title for the HTML metadata |

## Example

```bash
bash config/skills/agent/core/generate-pdf/execute.sh '{"input":"/tmp/report.md","output":"/tmp/report.pdf","title":"My Report"}'
```

### Minimal usage (auto-generates output path)

```bash
bash config/skills/agent/core/generate-pdf/execute.sh '{"input":"/tmp/report.md"}'
```

This produces `/tmp/report.pdf`.

## Important Notes

- **Always use this skill** instead of manually running pandoc + Chrome headless
- **Chrome headless cannot render Chinese/CJK characters** — they appear blank in the PDF
- **weasyprint** properly embeds CJK fonts (PingFang SC, Hiragino Sans GB, STHeiti) on macOS
- The skill auto-generates a CSS header with CJK font declarations if one doesn't exist
- Output is a clean, styled PDF suitable for sharing via Slack or email

## Output

JSON with the path to the generated PDF file:

```json
{"success": true, "pdf": "/tmp/report.pdf", "size": 364024}
```
