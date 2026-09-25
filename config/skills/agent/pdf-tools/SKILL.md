---
name: pdf-tools
description: Make polished PDFs from Markdown or styled HTML (headless Chrome preferred, WeasyPrint fallback, CJK-ready default stylesheet), merge several parts into one PDF, and read the text of a PDF someone sent you. When a dependency is missing it returns `needsSetup:true` — run `install-skill --id pdf-tools`.
category: content-creation
assignableRoles:
  - "*"
version: "1.0.0"
author: Crewly Team
tags:
  - pdf
  - document
  - report
  - markdown
  - html
  - chrome
  - weasyprint
  - merge
  - read-pdf
  - extract-text
  - pypdf
  - cjk
  - 中文
  - 文档
triggers:
  - make a pdf
  - generate pdf
  - markdown to pdf
  - html to pdf
  - merge pdfs
  - read this pdf
  - extract text from pdf
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 300000
---

# PDF Tools

Make PDFs people like to read, and read the PDFs people send you.

## Make a PDF (`render`)

```bash
# Markdown → PDF with the default A4 stylesheet (CJK fonts, tables, code, quotes)
bash {{AGENT_SKILLS_PATH}}/pdf-tools/execute.sh '{"action":"render","input":"/tmp/report.md","output":"/tmp/report.pdf","title":"Q3 报告"}'

# Your own styled HTML → PDF (kept exactly as you styled it)
bash {{AGENT_SKILLS_PATH}}/pdf-tools/execute.sh '{"action":"render","input":"/tmp/brief.html","output":"/tmp/brief.pdf"}'

# Several parts → one PDF, in order (.md / .html / .pdf)
bash {{AGENT_SKILLS_PATH}}/pdf-tools/execute.sh '{"action":"render","inputs":["/tmp/cover.html","/tmp/body.md","/tmp/appendix.pdf"],"output":"/tmp/full.pdf"}'
```

| Field | Default | Meaning |
|---|---|---|
| `input` / `inputs` | — | One file, or a list of parts merged in order |
| `output` | input path with `.pdf` | Where the PDF goes (required for several parts) |
| `title` | file name | Document title (Markdown only) |
| `css` | — | Extra stylesheet appended after the default one |
| `addDefaultStyle` | `false` | Also apply the default stylesheet to HTML input |
| `engine` | `auto` | `auto` (Chrome, else WeasyPrint), `chrome`, `weasyprint` |
| `lang` | `zh` | `lang` attribute of the generated HTML (font selection) |

**Engines.** Headless Chrome/Chromium renders exactly what a browser shows
(modern CSS, web fonts, CJK with system fonts) and is used whenever it is
installed. WeasyPrint is the fallback. Markdown goes through python-markdown
(or pandoc when the venv is missing).

**Writing HTML for print.** Use `@page { size: A4; margin: 18mm }`, and
`<div class="page-break"></div>` (default stylesheet) or `break-after: page` to
start a new page. For a cover page, render it as its own part and list it first.

Output: `{"success":true,"pdf":"/tmp/report.pdf","size":48213,"parts":1,"engine":"chrome"}`

## Read a PDF (`read`)

```bash
bash {{AGENT_SKILLS_PATH}}/pdf-tools/execute.sh '{"action":"read","input":"/path/to/file.pdf"}'
bash {{AGENT_SKILLS_PATH}}/pdf-tools/execute.sh '{"action":"read","input":"/path/to/file.pdf","pages":"1-3,7","textFile":"/tmp/file.txt"}'
```

Returns `{success, engine, pages, pagesRead, chars, text, truncated, textFile?}`.
Text is split with `--- page N ---` markers. Long documents are cut at
`maxChars` (default 20000) — pass `textFile` to get everything on disk. A `note`
says when the PDF has no text layer (scanned images).

## Other actions

- `merge` — `{"action":"merge","inputs":["a.pdf","b.pdf"],"output":"ab.pdf"}`
- `info` — `{"action":"info","input":"x.pdf"}` → pages, metadata, encrypted
- `check` — which engines exist here (`canRender`, `canRead`, `canMerge`)

## Setup

Declared in `skill.json` → `setup`; `install-skill --id pdf-tools` (agents) or
`crewly skills setup pdf-tools` (terminal) installs what is missing:
Python venv `~/.crewly/venv/pdf-tools` with pypdf, markdown and weasyprint;
optionally Chrome (Linux: `chromium`), Pango for WeasyPrint and Noto CJK fonts.
A missing dependency fails with `"needsSetup": true, "skill": "pdf-tools"` —
tell the user you are setting it up and run `install-skill`, don't give up.
