---
name: Canva Designs
description: List or search the owner's Canva designs, or fetch one by id — returns edit/view links and thumbnails (via the Canva grant held by Crewly Cloud). Read-only.
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
  - list canva designs
  - find the canva design
  - open in canva
  - which canva design
tags:
  - canva
  - designs
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Canva Designs

```bash
bash execute.sh --query "open day poster" --owned
bash execute.sh --id DAF…
```

## Output

```json
{"count":1,"designs":[{"id":"DAF…","title":"Open day poster","editUrl":"https://www.canva.com/…","viewUrl":"https://…","thumbnailUrl":"https://…","pageCount":1,"updatedAt":"…"}]}
```

`editUrl` / `viewUrl` are valid for 30 days, `thumbnailUrl` for 15 minutes —
share the edit link with people, do not store the thumbnail.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Canva (Settings → Integrations).
