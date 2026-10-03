---
name: Experiment Card
description: Attach an experiment to an optimisation ticket — hypothesis ("change X → metric Y from a to b"), a Search Console or GA4 metric (via seo-ops), an observation window (default 14 days). Crewly captures the baseline when the change ships, measures it when the window ends, labels it worked / didn't / inconclusive, resolves your prediction, writes the wiki experiment log and tells the owner.
version: 1.1.0
category: analysis
skillType: claude-skill
assignableRoles:
  - marketing
  - content-strategist
  - generalist
  - developer
  - fullstack-dev
  - product-manager
  - team-leader
  - orchestrator
triggers:
  - experiment
  - measure the impact
  - did it work
  - a/b
  - hypothesis
tags:
  - experiments
  - seo
  - analytics
  - outcomes
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 180000
---

# Experiment Card

A ticket that is meant to *move a number* (rewrite a title, add FAQ schema,
shorten the inquiry form) should carry an experiment, so we learn whether it
worked instead of assuming it did. Create the card **before** the change ships;
Crewly does the rest:

1. **Ship** — when the linked ticket reaches `done` (or you run `ship`), the
   windows are fixed and the **baseline** is fetched right away: the
   `windowDays` days that had settled before the ship day. The ship time is
   the ticket's move to `done` in its log. If you link a ticket that is
   already done and its log has no done time, `create` asks for
   `--shipped-at` (when the change went live).
2. **Wait** — the observation window is the `windowDays` days after the ship
   day. Nothing to do; don't re-check it by hand.
3. **Measure** — once those days have settled (Search Console +3 days, GA4
   +2), Crewly fetches the result and labels it:
   - **worked** — a real change in the hypothesis's direction (|z| ≥ 1.96);
   - **didn't** — enough data, but no real change (or the wrong way);
   - **inconclusive** — too little data (e.g. fewer than 10 form submissions
     across both windows, fewer than 30 clicks/sessions).
4. **Learn** — your prediction (recorded at ship with `--confidence`) is
   resolved, the result is appended to the wiki experiment log
   (`llm-curated/experiments/log.md`), the owner gets it, and a project
   ticket gets a log line. `show` has the whole timeline (the run's trace).

## Create

The metric comes from the seo-ops skill, so you need a seo-ops site config
(`--config`, absolute path; it names the GSC property / GA4 property and the
service-account credentials).

```bash
# Search Console: organic clicks to one page, on a project ticket
bash execute.sh create --hypothesis "FAQ schema on the H-1B guide → organic clicks from 120 to 160" \
  --source gsc --measure clicks --page https://visa.careerengine.us/h1b-guide \
  --from 120 --to 160 --config /abs/path/ce.seo-ops.json --project ce-site --ticket CE-31 --confidence 0.6

# GA4: inquiry-form submissions (all channels), on a harness ticket
bash execute.sh create --hypothesis "3-field inquiry form → submissions from 8 to 14 per two weeks" \
  --source ga4 --measure events --event generate_lead --channel all \
  --config /abs/path/ce.seo-ops.json --tkt TKT-212
```

- gsc measures: `clicks`, `impressions`, `ctr`, `position` (lower is better;
  direction defaults to `decrease`). Filters: `--page URL`, `--query Q`,
  `--page-match` / `--query-match exact|contains`.
- ga4 measures: `sessions` (Organic Search unless `--channel all`),
  `events` (`--event NAME`) and `conversions` (GA4 key events; `--event NAME`
  for one of them). Filter: `--page /landing-path` (a full URL is reduced to
  its path; the query string is dropped).
- `--window-days` 7–90, whole weeks preferred (default 14).
- One experiment per change: two changes on the same page in one window
  can't be told apart.

## Follow it

```bash
bash execute.sh list --status running
bash execute.sh show --id EXP-3          # baseline, result, verdict, timeline
bash execute.sh ship --id EXP-3          # only if it has no ticket, or shipped before the ticket closed
bash execute.sh measure --id EXP-3       # only after dueAt; normally automatic
bash execute.sh cancel --id EXP-3 --reason "change reverted"
```

If a fetch keeps failing (credentials, property access) the owner is told
once with the error; after 6 failures in a row it retries once a day.
