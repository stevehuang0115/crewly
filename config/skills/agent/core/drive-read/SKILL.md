---
name: Drive Read
description: Read the content of a Google Drive file (via the Google Workspace grant held by Crewly Cloud): Docs → text, Sheets → CSV, Slides → text, other files downloaded (text printed, binaries saved with --out). Read-only.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - read drive file
  - open file from drive
  - download from drive
tags:
  - google
  - drive
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Drive Read

```bash
bash execute.sh --id 1AbC…                        # print content (text/CSV) as JSON
bash execute.sh --id 1AbC… --out /tmp/report.pdf  # save (binary decoded) and print metadata
```

## Output

```json
{"file":{"id":"1AbC…","name":"Q3 plan","mimeType":"application/vnd.google-apps.document","webViewLink":"https://…"},"contentType":"text/plain","encoding":"utf8","bytes":1234,"content":"…"}
```

For a Google Doc / Sheet / Slides prefer `docs-read` / `sheets-read` /
`slides-read` — they keep structure (headings, cell grid, per-slide lines).
Files over 10 MB are refused with a `webViewLink` to open instead.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace (Settings → Integrations).
A `403` with `reason: "google_error"` on a write means the file was not
created by Crewly — the grant only edits files Crewly made (`drive.file`).
