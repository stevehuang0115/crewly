---
name: Drive Upload
description: Upload a local file or text to the owner's Google Drive (via the Google Workspace grant held by Crewly Cloud), optionally into a folder or converted to a Google Doc/Sheet/Slides. Files Crewly uploads can later be edited by docs-write / sheets-write.
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
  - upload to drive
  - save to google drive
  - put file in drive
  - share file via drive
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

# Drive Upload

```bash
bash execute.sh --path ./report.pdf --folder 1Fo…            # binary-safe
bash execute.sh --path ./notes.md --convert doc               # becomes a Google Doc
bash execute.sh --name summary.txt --text "…" --folder 1Fo…
```

## Output

```json
{"success":true,"file":{"id":"1AbC…","name":"report.pdf","mimeType":"application/pdf","webViewLink":"https://…"}}
```

Limit: 10 MB per upload. Share the `webViewLink` with people (Drive
permissions are the owner's — this skill does not change sharing).

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace (Settings → Integrations).
A `403` with `reason: "google_error"` on a write means the file was not
created by Crewly — the grant only edits files Crewly made (`drive.file`).

## Choosing a Google account

Several Google accounts can be connected at once. Without `--account` the call uses the default one (the first you connected, or whichever you marked default on the Connections page). Name one explicitly when it matters:

```bash
bash execute.sh --account work@company.com ...
```

The account must be connected *for this product* — Google consent is per product (Gmail / Calendar / Drive), so an account connected only for Calendar cannot read Drive.
