---
name: Canva Export
description: Export a Canva design to PDF, PNG, JPG, PPTX, GIF or MP4 (via the Canva grant held by Crewly Cloud). Waits for Canva's export job and returns download URLs; with --out / --out-dir the files are downloaded. Use this to turn a finished Canva video/poster into a file you can post or send.
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
  - export from canva
  - download the canva design
  - render the canva video
  - canva to pdf
tags:
  - canva
  - export
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Canva Export

```bash
bash execute.sh --id DAF… --format mp4 --out /tmp/reel.mp4
bash execute.sh --id DAF… --format png --out-dir /tmp/poster-pages
```

## Output

```json
{"success":true,"jobId":"…","urls":["https://export-download.canva.com/…"],"savedTo":["/tmp/reel.mp4"]}
```

Download URLs are short-lived — save the file right away. Exports of
large videos can take a minute or two; the backend polls for up to 2 min
and answers `504` if Canva is still rendering (retry later).

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Canva (Settings → Integrations).
