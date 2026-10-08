---
name: Find App Template
description: Search the Crewly Marketplace for a Crewly App template (a ready-made small web app someone published, with no data) that matches what the owner needs. Run it BEFORE building a new Crewly App; if a template fits, start from it with use-app-template and adapt it instead of writing the app from scratch.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - build an app
  - make an app
  - new crewly app
  - app template
  - marketplace app
  - tracker app
  - checklist app
tags:
  - apps
  - templates
  - marketplace
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Find App Template

**Before you build a new Crewly App, look for a template.** Someone may have
published one that already does most of it.

```bash
bash execute.sh --query "chore chart for kids with points"
bash execute.sh --query "class sign-up sheet" --category forms --limit 3
bash execute.sh --query "habit tracker" --tag habits
```

Output (best match first):

```json
{"success":true,"query":"chore chart for kids","total":2,
 "next":"Look at the best match (previewUrl). If it fits, run use-app-template tpl-… --dir ./<dir> and adapt it; tell the owner in one line which template you started from.",
 "templates":[{"templateId":"tpl-k3m9p2x7aq","name":"Chore chart","description":"Kids' chores with points and a weekly total.",
   "category":"family","tags":["chores","kids"],"author":"Steve","installs":12,"version":3,
   "capabilities":[],"previewUrl":"https://apps.crewlyai.com/_t/tpl-k3m9p2x7aq"}]}
```

- Judge the match on `name`, `description` and `tags`. Opening `previewUrl`
  shows it running with sample data (nothing is saved).
- **A good match** → `use-app-template <templateId> --dir ./<dir>`: you get a
  new app in this account (empty data) and its files in `<dir>`. Change what
  the owner needs, then `publish-app --dir ./<dir> --notify`. Tell the owner in
  one line, e.g. "I started from the Marketplace template “Chore chart” and
  added weekly rewards."
- **No good match** (`templates` empty, or none fits) → build it yourself with
  `publish-app` as usual.
- `capabilities` (e.g. `media_capture`) are not granted to the new app; ask
  the owner for them as the publish-app skill says.
- Options: `--query` (required), `--tag`, `--category` (`productivity`,
  `tracker`, `checklist`, `forms`, `education`, `family`, `health`, `finance`,
  `events`, `games`, `business`, `other`), `--limit` (1–20, default 5).
