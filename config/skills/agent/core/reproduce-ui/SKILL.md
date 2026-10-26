---
name: Reproduce UI
description: Turn a UI bug report (a screenshot and a sentence) into evidence - match it to a feature-map entry, open that feature in a headless browser and save screenshot, console errors, failed requests and timings, plus one line for the ticket - before you reproduce or fix it.
version: 1.1.0
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
  - bug report
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
# From the bug report: the owner's sentence plus the words you read on the
# screenshot (headings, tab names, button labels). Picks the feature, runs it.
bash execute.sh --report "runs tab is blank — Tickets, Board · Requests · Runs"

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
(failed requests and responses ≥ 400), `report.md` and `summary.json`; its
`ticketLine` is the one line to put in the ticket ("Reproduced `/x`: key
element NOT found; 1 console error; 2 failed requests (first: POST /api/b →
500); evidence: <dir>"). Exit 0 means the key element appeared; exit 2 means
it did not (the evidence is still there — that is the bug, or the wrong
selector); exit 1 is a usage or browser problem; exit 3 means the report
matched no single feature (the candidates are on stderr — pass `--route`).

How `--report` matches: every word of the report is looked up in each
feature's title and **Expected** line (2 points), its route, **Reach** and
**Elements** (1 point), and its tab names (4 points, and the tab becomes
`?tab=`). A feature wins with two or more matching words, 3+ points and half
again as much as the runner-up. The words on the screenshot are what make
it unambiguous: a report of "blank page" alone matches nothing; "blank page,
Tickets, Runs" opens `/tickets?tab=runs`. Read the screenshot first and put
what you see into the report text.

How to use it on a report:

1. Write the report text: the owner's sentence, then the headings, tab
   names and labels you can read on the screenshot. Run `--report` with it
   (or `--report-file`). If it exits 3, pick the route from the candidates it
   printed and run `--route`.
2. Compare `screenshot.png` with the owner's screenshot; read `console.json`
   and `requests.json` first — a failed `/api/...` call explains most blank
   or stale pages. `report.md` quotes the report and says which words chose
   the feature, so a wrong match is visible at a glance.
3. Put `ticketLine` in the ticket (the evidence folder stays on this
   machine; quote the folder path and the key lines, not the files), then
   fix. After the fix, run it again and put the second line under the first
   as proof.

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
