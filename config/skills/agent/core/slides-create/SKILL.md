---
name: Slides Create
description: Create a Google Slides deck in the owner's Drive from an outline — one TITLE_AND_BODY slide per entry with its title and bullet lines (via the Google Workspace grant held by Crewly Cloud). Share the link when done.
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
  - create slides
  - make a deck
  - build a presentation
  - turn this into slides
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

# Slides Create

```bash
bash execute.sh --title "Q3 review" --outline-file /tmp/q3.md
```

`/tmp/q3.md`:
```
# Highlights
- Revenue +12%
- Two launches
# Risks
- Hiring
```

## Output

```json
{"success":true,"id":"1AbC…","title":"Q3 review","slideCount":2,"webViewLink":"https://docs.google.com/presentation/d/1AbC…/edit"}
```

Layout is the default theme's TITLE_AND_BODY; no images. Max 60 slides.
For designed decks (brand templates, images, video) use the Canva skills.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace (Settings → Integrations).
A `403` with `reason: "google_error"` on a write means the file was not
created by Crewly — the grant only edits files Crewly made (`drive.file`).
