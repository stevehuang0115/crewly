---
name: Signal Digest
description: "Daily signal digest for a site you own as team lead: GA4 traffic and key events, Search Console opportunities (low-CTR top-3, near-miss 4-20, rising, cannibalization), the site's inbound mail and broken pages / JS errors, minus what was already tried — turned into 3-5 ranked actions the owner answers Do / Skip on one Slack card. Do opens an experiment ticket."
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - daily signal digest
  - daily signals
  - what should we try on the site
  - site opportunities
tags:
  - seo
  - analytics
  - experiments
  - owner-decisions
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 180000
---

# Signal Digest (team lead)

One run per site per day (#987, `specs/2026-10-03-signal-digest.md`):

1. **collect** — gathers the signals and drafts actions.
2. **you decide** — keep the 3–5 actions most worth the owner's tap, rewrite them in plain words,
   add your own (e.g. a question the inbox keeps asking → an FAQ section).
3. **propose** — the owner gets **one card**: each action with **Do** / **Skip**.
   - **Do** opens an experiment ticket in the site's project and, when the action names an
     `experiment` metric, an **experiment card** (#986) linked to it: the baseline is captured when
     the ticket is done and the result is measured after 14 days, automatically. You get a
     `[SIGNAL DIGEST]` message with both ids. Ship it and close the ticket.
   - **Skip** keeps that action off your list for 30 days. A Do keeps it off for 90.
   - Unanswered actions are replaced by your next digest (you may propose them again).

## Setup (once per site)

The config is the site's **seo-ops** config plus a `signalDigest` section — copy
`signal-digest.config.example.json`. Google access is seo-ops's service account
(`SEO_OPS_GOOGLE_CREDENTIALS`, read-only: Search Console user + GA4 Viewer).

| `signalDigest` key | Meaning |
|---|---|
| `site` | Site name on the card and in the history (default: host of `siteUrl`) |
| `project` | Project the Do tickets go into (name or id). Without it a Do opens no ticket |
| `days` | Window, compared with the window before it (default 7) |
| `ga4.conversionEvents` | Key events that count as conversions (default: all key events) |
| `inbox.query` / `.account` / `.max` | Gmail search for the site's inbound requests (Google connector) |
| `errors.checkSitemap` / `.maxUrls` | Fetch up to N sitemap pages and report the ones not answering 200 (default on, 60) |
| `errors.url` or `errors.command` | JS errors as JSON: `[{"message","count","url"}]` or `{"errors":[…]}` |
| `experimentLog` | Extra Markdown experiment log; a draft whose query/page it mentions is dropped (experiment cards are always checked) |
| `thresholds` | `ga4DropPct` (20), `ga4MinPrevSessions` (50), `ga4MinPrevKeyEvents` (5) |

Daily run: `bash execute.sh schedule --config <file> [--cron "0 8 * * *"] [--timezone America/New_York]`
prints the cron task; hand it to the orchestrator to create with `create-cron`.

## Commands

```bash
bash execute.sh collect --config ce.signal.json            # JSON: signals, alreadyTried, candidates
bash execute.sh propose --config ce.signal.json --actions actions.json
```

`collect` prints `sources` (ok / not configured / error: why), the signals (`ga4`, `gsc`,
`inbox`, `errors`), `alreadyTried` (dropped drafts and why: the owner's earlier Do / Skip, an
experiment card on the same query or page, or the experiment log), `pendingOnOwner` and up to 10
`candidates`, best first. GA4 respects seo-ops' `ga4HostName`. Exit `1` when no source could be examined — then say so in your
team channel; do not propose from nothing.

`--actions` is a JSON array (file or inline) of 3–5 actions, best first:

```json
[{"key":"gsc:low-ctr:h1b visa fee","source":"gsc",
  "signal":"'h1b visa fee' ranks #2 with 4% CTR on 900 impressions (7 days)",
  "proposal":"Rewrite the title and description of /h1b-fee to answer the fee question",
  "expectedEffect":"CTR 4% → ~16%: about +100 clicks a week",
  "effort":"S — 1 h","metric":"GSC CTR for 'h1b visa fee'",
  "experiment":{"source":"gsc","measure":"ctr","query":"h1b visa fee","page":"https://visa.careerengine.us/h1b-fee"}}]
```

- `key` is the action's identity across days. Keep the draft's key when you keep its action;
  for your own, use `<source>:<kind>:<subject>`.
- `source`: `ga4` | `gsc` | `inbox` | `errors` | `other`.
- Lengths: signal ≤ 400, proposal ≤ 200, expectedEffect ≤ 240, effort ≤ 60 characters.
- `experiment` (optional, keep the draft's): the seo-ops metric that measures it —
  `source` gsc (`clicks` / `impressions` / `ctr` / `position`, filters `query`, `page`) or
  ga4 (`sessions` / `events`, `event`, `channel`). Leave it out for fixes that move no metric
  (a broken page, a JS error).

`propose` answers `{"success":true,"digestId":"SD-4","card":"posted"}`. A `409` lists actions
the owner already decided — replace them and propose again.

## Rules

- Never propose what `alreadyTried` lists, and never more than 5 actions.
- Each action states signal → proposal → expected effect → effort, with a number when there is one.
- This skill only reads Google and Gmail; it never changes the site.
