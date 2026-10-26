---
name: Reproduce UI
description: Open a Crewly dashboard feature by its feature-map entry in a headless browser and save evidence (screenshot, console errors, failed requests, timings) before you reproduce or fix a UI bug report.
version: 1.0.0
category: development
skillType: claude-skill
assignableRoles:
  - developer
  - frontend-developer
  - fullstack-dev
  - qa
  - qa-engineer
  - team-leader
  - orchestrator
  - generalist
triggers:
  - reproduce
  - screenshot bug
  - UI bug
  - feature map
tags:
  - frontend
  - debugging
  - evidence
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 180000
---

# Reproduce UI

A bug report from the owner is often a phone screenshot and one sentence.
Before you guess, open the feature the way a user does and keep the evidence.
The feature map (`frontend/FEATURE_MAP.md` in a Crewly checkout, #811) says
for every route how a user reaches it, what it should do and which
`data-testid` anchors it has; this skill turns one map entry into a run.

```bash
# By route (tabs go in the query string, as the map shows them)
bash execute.sh --route "/tickets?tab=runs"

# By a word from the map's Routes table; :params get values
bash execute.sh --feature "Run detail" --param id=<work item id>

# Your own wait target and a full-page shot
bash execute.sh --route /wiki --wait '[data-testid="wiki-recent-list"]' --full-page

# See what would run (route, URL, wait selector, evidence folder) without a browser
bash execute.sh --feature Usage --dry-run
```

What you get back is one JSON line with `dir`: the evidence folder under
`$CREWLY_HOME/evidence/<utc stamp>-<route>/` holding `screenshot.png`,
`console.json` (console errors, warnings and page errors), `requests.json`
(failed requests and responses ≥ 400), `report.md` and `summary.json`.
Exit 0 means the key element appeared; exit 2 means it did not (the
evidence is still there — that is the bug, or the wrong selector); exit 1 is
a usage or browser problem.

How to use it on a report:

1. Find the feature in the map (the words on the screenshot are usually in
   a page's **Expected** or **Elements** line). Note its route and `?tab=`.
2. Run this skill on that route. Compare `screenshot.png` with the owner's
   screenshot; read `console.json` and `requests.json` first — a failed
   `/api/...` call explains most blank or stale pages.
3. Put the `report.md` path (or its key lines) in the ticket, then fix. After
   the fix, run it again and attach the second folder as proof.

Notes:

- The dashboard must be running on this machine (`CREWLY_API_URL`, default
  `http://localhost:8787`); loopback needs no token.
- Needs Google Chrome (or `--browser <chromium path>`); playwright-core ships
  with Crewly, no browser download.
- `--feature` needs the map: a Crewly checkout at `CREWLY_PROJECT_PATH`, or
  `--map <path>`. Without a map, pass `--route` and `--wait`.
- Pages behind a Cloud sign-in or that need a real agent session show their
  empty or signed-out state; that is still evidence, say so in the ticket.
- For a page the owner is looking at in Chrome right now, or a site outside
  this dashboard, use the `remote-browser` skill instead.
