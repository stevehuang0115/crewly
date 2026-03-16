---
name: Send PDF to Slack
description: "Convert a markdown file to a styled PDF (with embedded local images) and upload it to a Slack channel. Supports markdown image syntax ![alt](/path/to/image.png) \u2014 local absolute and relative image paths are automatically resolved and embedded in the PDF."
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - send pdf
  - pdf to slack
  - markdown to pdf
  - export pdf
tags:
  - communication
  - slack
  - pdf
  - markdown
  - export
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Send PDF to Slack

Converts a markdown file to a styled PDF and uploads it to a Slack channel via the `/api/slack/upload-file` endpoint. Supports embedding local images referenced in the markdown.

## Image Support

The skill automatically handles local images referenced in markdown:

- **Absolute paths**: `![alt](/Users/me/images/photo.png)` — converted to `file://` URLs
- **Relative paths**: `![alt](./images/photo.png)` — resolved relative to the markdown file's directory
- **Remote URLs**: `![alt](https://example.com/photo.png)` — passed through as-is

Images are rendered at full width (max 100% of page) with auto height scaling, centered with a subtle border.

## Prerequisites

- **python3** must be installed (comes with macOS, or `brew install python3`)
- On first run, a virtual environment is created at `~/.crewly/venv/pdf-tools/` with `weasyprint` and `markdown` packages installed automatically

## Usage

```bash
bash config/skills/orchestrator/send-pdf-to-slack/execute.sh \
  --channel C0123ABC \
  --file /path/to/document.md \
  --title "Weekly Report" \
  --text "Here is the report" \
  --thread 1707123456.789000
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--channel`, `-c` | Yes | Slack channel ID to upload the PDF to |
| `--file`, `-f` | Yes | Path to the markdown file to convert |
| `--title`, `-T` | No | Title for the uploaded PDF (defaults to filename) |
| `--text`, `-t` | No | Initial comment to include with the upload |
| `--thread`, `-r` | No | Slack thread timestamp for threaded upload |

## Example: Daily Report with Infographics

Create a markdown file with embedded images:

```markdown
# AI Daily Report - 2026-02-21

## 1. Paper Title
Summary of the paper.

![Paper Infographic](/path/to/output/infographic-1.png)

## 2. Another Paper
Summary here.

![Another Infographic](/path/to/output/infographic-2.png)
```

Then send it:

```bash
bash config/skills/orchestrator/send-pdf-to-slack/execute.sh \
  --channel D0AC7NF5N7L \
  --file /path/to/daily-report.md \
  --title "AI Daily Report 2026-02-21" \
  --text "Today's AI report with infographics" \
  --thread 1771651155.079579
```

## PDF Styling

- A4 page size with 20mm/15mm margins
- System fonts with CJK support (PingFang SC, Noto Sans SC)
- Images: max-width 100%, centered, with subtle border
- Tables: full width, bordered cells
- Code blocks: gray background with monospace font

## Output

JSON response from the upload API with `fileId` on success. Also emits a `[NOTIFY]` block for chat service integration.

## Error Handling

- Exits with error if `python3` is not installed (includes install instructions)
- Auto-installs weasyprint/markdown into a persistent venv on first run
- Exits with error if the markdown file does not exist
- Exits with error if PDF conversion fails
- Temp PDF files are cleaned up after upload (stored in `~/.crewly/tmp/slack-pdfs/`)
