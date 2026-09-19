---
name: Docs Read
description: Read a Google Doc as plain text — headings become `#` lines, bullets `-`, table rows `a | b` (via the Google Workspace grant held by Crewly Cloud). Accepts a document id or its URL. Read-only.
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
  - read google doc
  - open the doc
  - what does the document say
  - summarize this doc
tags:
  - google
  - docs
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Docs Read

```bash
bash execute.sh --id 1AbC…
bash execute.sh --id "https://docs.google.com/document/d/1AbC…/edit"
```

## Output

```json
{"id":"1AbC…","title":"Q3 plan","webViewLink":"https://docs.google.com/document/d/1AbC…/edit","text":"# Q3 plan\n\n- Ship…"}
```

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace (Settings → Integrations).
A `403` with `reason: "google_error"` on a write means the file was not
created by Crewly — the grant only edits files Crewly made (`drive.file`).
