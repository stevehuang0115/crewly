---
name: Docs Write
description: Create a Google Doc in the owner's Drive, or append text to a document Crewly created (via the Google Workspace grant held by Crewly Cloud). Writes as the owner — say what you created and share the link.
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
  - create google doc
  - write a doc
  - append to the doc
  - put this in a google doc
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

# Docs Write

```bash
bash execute.sh --title "Weekly summary" --text-file /tmp/summary.md
bash execute.sh --id 1AbC… --text "Follow-ups: …"
```

## Output

```json
{"success":true,"action":"create","id":"1AbC…","title":"Weekly summary","webViewLink":"https://docs.google.com/document/d/1AbC…/edit"}
```

Text is inserted as plain paragraphs (Markdown is not rendered). Appending
to a document the owner made outside Crewly needs the Docs write scope —
a `403 google_error` means "create a new doc instead, or ask the owner to
re-connect Google Workspace once the scope is enabled".

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
