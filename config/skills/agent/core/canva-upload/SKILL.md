---
name: Canva Upload
description: Upload a local image or video into the owner's Canva media library as an asset (via the Canva grant held by Crewly Cloud). The asset id can seed a new design with canva-create.
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
  - upload to canva
  - add image to canva
  - put this video in canva
tags:
  - canva
  - upload
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Canva Upload

```bash
bash execute.sh --path ./open-day.jpg --name "Open day photo"
```

## Output

```json
{"success":true,"asset":{"id":"AAB…","name":"Open day photo","thumbnailUrl":"https://…"}}
```

Limit 50 MB per file. Then `canva-create --asset <id>` starts a design
with it, or a person drops it into an existing design in Canva.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Canva (Settings → Integrations).
