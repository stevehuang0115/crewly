---
name: Send PDF to Slack
description: Convert a markdown file to PDF and upload it to a Slack channel.
version: 1.0.0
category: communication
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

Converts a markdown file to PDF using `weasyprint` (Python) and uploads it to a Slack channel via the `/api/slack/upload-file` endpoint.

## Prerequisites

- **python3** must be installed (comes with macOS, or `brew install python3`)
- On first run, a virtual environment is created at `~/.crewly/venv/pdf-tools/` with `weasyprint` and `markdown` packages installed automatically

## Usage

```bash
bash config/skills/agent/send-pdf-to-slack/execute.sh --channel C0123ABC --file /path/to/document.md --title "Weekly Report"
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--channel`, `-c` | Yes | Slack channel ID to upload the PDF to |
| `--file`, `-f` | Yes | Path to the markdown file to convert |
| `--title`, `-T` | No | Title for the uploaded PDF (defaults to filename) |
| `--text`, `-t` | No | Initial comment to include with the upload |
| `--thread`, `-r` | No | Slack thread timestamp for threaded upload |

## Examples

```bash
# Basic upload
bash execute.sh --channel C0123ABC --file report.md

# Upload with title and comment
bash execute.sh --channel C0123ABC --file report.md --title "Q4 Report" --text "Here is the quarterly report"

# Upload in a thread
bash execute.sh --channel C0123ABC --file notes.md --thread 1707123456.789000
```

## Output

JSON response from the upload API with `fileId` on success. Also emits a `[NOTIFY]` block for chat service integration.

## Error Handling

- Exits with error if `python3` is not installed (includes install instructions)
- Auto-installs weasyprint/markdown into a persistent venv on first run
- Exits with error if the markdown file does not exist
- Exits with error if PDF conversion fails
- Temp PDF files are cleaned up after upload (stored in `~/.crewly/tmp/slack-pdfs/`)
