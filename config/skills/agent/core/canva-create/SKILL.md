---
name: Canva Create
description: Create a new Canva design in the owner's account — a preset (doc / whiteboard / presentation), a custom size (e.g. 1080x1920 for stories), or one built from an uploaded asset (via the Canva grant held by Crewly Cloud). Returns the edit link for a person to finish the design.
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
  - create canva design
  - new design in canva
  - make a poster in canva
  - start a canva deck
tags:
  - canva
  - create
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Canva Create

```bash
bash execute.sh --title "Open day poster" --size 1080x1350
bash execute.sh --title "Reel cover" --asset AAB…      # after canva-upload
```

## Output

```json
{"success":true,"design":{"id":"DAF…","title":"Open day poster","editUrl":"https://www.canva.com/…"}}
```

The Connect API does not fill designs with text or generate video: create
the design, upload the assets, then hand the `editUrl` to a person (or
export an existing finished design with `canva-export`). Brand templates
need Canva Enterprise and are not wired.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Canva (Settings → Integrations).
