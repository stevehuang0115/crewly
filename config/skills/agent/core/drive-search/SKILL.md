---
name: Drive Search
description: Search the owner's Google Drive by text, type or folder (via the Google Workspace grant held by Crewly Cloud). Returns file ids to pass to drive-read / docs-read / sheets-read / slides-read. Read-only.
version: 1.0.0
category: productivity
skillType: claude-skill
triggers:
  - search drive
  - find file in drive
  - look up a document
  - which spreadsheet
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

# Drive Search

```bash
bash execute.sh --query "Q3 plan"                 # names + full text, newest first
bash execute.sh --mime sheet --max 5              # 5 most recent spreadsheets
bash execute.sh --folder 1AbC... --query budget   # inside one folder
```

## Output

```json
{"count":1,"files":[{"id":"1x…","name":"Q3 plan","mimeType":"application/vnd.google-apps.document","modifiedTime":"…","webViewLink":"https://…","owners":["ann@example.com"]}]}
```

`mimeType` tells you which skill reads it: `…document` → `docs-read`,
`…spreadsheet` → `sheets-read`, `…presentation` → `slides-read`, anything
else → `drive-read`.

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
