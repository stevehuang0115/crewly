---
name: Generate PDF
description: Convert a Markdown (or HTML) file to a styled PDF with full CJK (Chinese/Japanese/Korean) font support. Thin wrapper over the pdf-tools skill — headless Chrome preferred, WeasyPrint fallback. For multi-part documents, merging or reading PDFs use pdf-tools directly.
version: 2.0.0
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
  - chrome
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

Convert a Markdown (or HTML) file to a professionally styled PDF with full CJK
(Chinese/Japanese/Korean) font support.

This skill is kept for compatibility; it calls **`pdf-tools`**
(`{{AGENT_SKILLS_PATH}}/pdf-tools/execute.sh`), which also merges several parts
into one PDF and reads PDFs. Prefer `pdf-tools` for anything beyond one file.

## Pipeline

1. **Markdown → HTML** with a clean A4 stylesheet (CJK font stacks: PingFang /
   Hiragino on macOS, Noto CJK on Linux). HTML input is printed as-is.
2. **HTML → PDF** with headless Chrome/Chromium when installed, else WeasyPrint.
   Chrome renders CJK correctly whenever CJK fonts are installed (macOS has them;
   on Linux the pdf-tools setup installs `fonts-noto-cjk`).

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `input` | Yes | Path to the input Markdown (or HTML) file |
| `output` | No | Path for the output PDF (defaults to the input path with `.pdf`) |
| `title` | No | Document title |
| `css` | No | Extra stylesheet appended to the default one |
| `engine` | No | `auto` (default), `chrome`, `weasyprint` |

## Example

```bash
bash {{AGENT_SKILLS_PATH}}/core/generate-pdf/execute.sh '{"input":"/tmp/report.md","output":"/tmp/report.pdf","title":"My Report"}'
```

## Output

```json
{"success": true, "pdf": "/tmp/report.pdf", "size": 364024, "engine": "chrome"}
```

If a dependency is missing the result carries `"needsSetup": true, "skill": "pdf-tools"`:
tell the user you are setting up the PDF tools and run `install-skill --id pdf-tools`.
