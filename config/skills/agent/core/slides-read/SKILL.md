---
name: Slides Read
description: Read a Google Slides presentation as text — every text line per slide plus speaker notes (via the Google Workspace grant held by Crewly Cloud). Accepts an id or URL. Read-only.
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
  - read the slides
  - open the presentation
  - what is in the deck
  - summarize the deck
tags:
  - google
  - slides
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Slides Read

```bash
bash execute.sh --id 1AbC…
```

## Output

```json
{"id":"1AbC…","title":"Pitch","slideCount":2,"webViewLink":"https://…","slides":[{"index":1,"lines":["Why now","Market is moving"],"notes":"say hi"},{"index":2,"lines":["Plan"]}]}
```

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace (Settings → Integrations).
A `403` with `reason: "google_error"` on a write means the file was not
created by Crewly — the grant only edits files Crewly made (`drive.file`).
