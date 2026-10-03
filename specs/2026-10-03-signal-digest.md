# Daily signal digest

Status: implemented (#987, part of the autonomous-loops epic #982)
Date: 2026-10-03

## Why

The epic's loop is signal → hypothesis → ticket → ship → measure → learn. Today the first step
depends on the owner noticing something. The signals are already reachable but scattered:

- the seo-ops skill reads Search Console and GA4;
- the Google connector reads the site's mailbox;
- a site's broken pages and JS errors have no reader at all.

The digest turns them into a short list of actions the owner can approve from a phone, once a day.

## 1. The run

A **scheduled job per site, owned by the team lead**. The orchestrator creates a cron task for
the lead. `signal-digest schedule` prints the exact `create-cron` object; leads do not create
crons themselves.

1. `signal-digest collect --config <site>.json` gathers, for the window (default 7 days) against
   the window before it:
   - **GA4:** sessions, organic sessions, key events (optionally only `ga4.conversionEvents`)
     and key events by event name.
   - **Search Console**, using seo-ops' own analysis and thresholds: low-CTR top-3, near-miss
     4–20, rising queries and cannibalisation, each with its best page.
   - **Inbox:** the site's inbound requests, from a Gmail search (`inbox.query`) through the
     Google connector. Until per-person access (#968) is in use, this is a dedicated site
     mailbox.
   - **Site errors:**
     - up to `errors.maxUrls` (60) sitemap pages fetched, a different slice each day (rotating
       through the sitemap), with every page that does not answer 200 reported;
     - JS errors as JSON from `errors.url` or `errors.command`.
   - **What was already tried**, checked first:
     - the site's digest history (`GET /api/signal-digests/history`): a draft whose key the
       owner chose Do on (within 90 days) or skipped (within 30 days) is dropped;
     - the experiment cards (#986, `GET /api/experiments`): a draft whose query or page a
       planned or running card measures, or one done within 90 days, is dropped;
     - optionally an extra Markdown log (`experimentLog`): a draft whose query or page it
       mentions is dropped.
     Each dropped draft is listed under `alreadyTried` with why.
   GA4 reports respect seo-ops' `ga4HostName` (one property, several sites).

   Each draft carries an `experiment` spec (the seo-ops metric that measures it) where one
   applies: CTR for a title rewrite, position for near-miss and cannibalisation, clicks for a
   new topic, sessions, or the one configured conversion event for a GA4 drop.

   It prints JSON: each source's status (`ok` / `not configured` / `error: why`), the signals,
   `alreadyTried`, `pendingOnOwner` and up to 10 **rule-ranked draft actions**:

   | Signal | Draft | Ranked by |
   |---|---|---|
   | Key events down ≥ 20 % (≥ 5 before) | find and fix the form drop | always first |
   | Sessions down ≥ 20 % (≥ 50 before) | find the channel / landing pages that lost them | next |
   | Low-CTR top-3 query | rewrite that page's title / description | extra clicks a week at the position's typical CTR |
   | Near-miss 4–20 | expand the page, add internal links | extra clicks at #3 × 0.6 |
   | Rising query, new or beyond #10, not covered above | write a page if none answers it | weekly impressions × 0.05 |
   | Cannibalised query | make one page the winner | weekly impressions × 0.05 |
   | Broken sitemap page | fix or redirect, drop from the sitemap | fixed |
   | JS error | fix it | its count |

   Exit `1` when no source could be examined: there is nothing to propose from. A source that
   fails (any exception) is reported as `error: why` and the others still run. execute.sh
   reports the statuses to `POST /api/signal-digests/sources`; the owner is told once when a
   source starts or stops failing (specs/2026-10-03-loops-review-fixes.md §2.2), and the lead
   posts nothing about it.
2. **The lead decides.** It keeps 3–5 actions (rewritten as needed, or its own, e.g. a question
   the inbox keeps asking). Each states signal → proposal → expected effect → effort, plus an
   optional metric.
3. `signal-digest propose --actions <file>` → `POST /api/signal-digests`.

## 2. The contract (`POST /api/signal-digests`, the lead's session)

`{ site, project?, config?, items: [3–5 × { key, source, signal, proposal, expectedEffect, effort, metric?, experiment? }] }`

| Field | Rule |
|---|---|
| `key` | Identity of the action across days (`gsc:low-ctr:<query>`). Unique in the digest; case and spacing ignored. ≤ 160 characters. |
| `source` | `ga4` / `gsc` / `inbox` / `errors` / `other` |
| `signal` / `proposal` / `expectedEffect` / `effort` | Required, one line; ≤ 400 / 200 / 240 / 60 characters |
| `metric` | Optional (≤ 200): what the experiment measures |
| `project` | Project the Do tickets go into (name, id or path) |
| `config` | Absolute path of the seo-ops site config; the experiment cards measure with it (the skill sends it) |
| `experiment` | Optional `{ source: gsc\|ga4, measure, page?, query?, event?, channel? }`. Only the shape is checked here; the experiment service validates it when a Do creates the card |

A failed rule answers 400, naming the item, the field and an example.

**History**, per site:
- **Do** blocks the key for 90 days (it is being tried).
- **Skip** blocks it for 30 days.
- A proposal that contains a blocked key answers **409**, listing each one with the date and
  the digest. Nothing is stored.

**One card a day:** while the site has a digest from the last 20 hours with open actions, the
same actions again return it and different ones answer 409.

**Replacing:** a new digest for a site first marks that site's earlier unanswered actions
`expired`. Their cards read "No answer — replaced by a newer digest", and they may be proposed
again.

Digests are stored in `~/.crewly/signal-digests.json` (`SD-<n>`). Ones with nothing open are
pruned 180 days after their last change.

## 3. The card

ONE Slack message, posted by the lead's own bot (else the shared bot under its name) in the
lead's team channel, else in the owner's DM:

```
[header]  Daily signals · visa.careerengine.us
[context] Owen · Sat 10/3 · Do opens an experiment ticket · Skip keeps it off the list for 30 days · SD-4
[context] Sources: GA4 ✓ · Search Console ✓ · Inbox — not set up
[section] *1. Rewrite the title and description of /h1b-fee*
          Signal: 'h1b visa fee' ranks #2 with 4.0% CTR on 900 impressions (7 days)
          Expected: CTR 4.0% → ~16%: about +108 clicks a week · Effort: S — 1 h
[actions] [Do] [Skip]
… one section + buttons per action
```

- Buttons: `action_id` `decision:signal:<n>:do|skip`, value `{"s":"SD-4","n":1,"o":"do","i":"<instance>"}`.
  The `decision:` prefix rides the decision-card interactivity route (Socket Mode regex, Cloud
  relay, `POST /api/slack/interactivity`). The decision service ignores these buttons because
  their value carries no decision id.
- Same checks as decision cards: this instance, the stored card (channel and ts), the owner,
  and the item still open.
- An answered action loses its buttons and shows `✔ Do → CE-12`, `✔ Do — no ticket: <why>`
  or `⤼ Skipped`. The card is redrawn with the bot that posted it.
- The owner can also answer with `POST /api/signal-digests/:id/items/:n {choice}`. This route
  is owner only: it needs the API token even from loopback (`requireOwnerToken`), and a call with
  `X-Agent-Session` gets 403.
- Not supported: reactions and thread replies (a card holds several questions, so one ✅ would
  be ambiguous); deadlines (an unanswered action is simply replaced the next day).

## 4. Do and Skip

- **Do** opens a ticket in the digest's `project` as the owner:
  - status `ready`, labels `experiment` + `signal-digest`, source `signal-digest:SD-4#1`;
  - the lead's team, or no team when the project does not have it;
  - title `Experiment: <proposal>`;
  - the description holds the signal, proposal, expected effect and effort, plus an
    **Experiment** section: hypothesis (proposal → expected effect), metric, baseline captured
    at ship time, a 14-day window, and the signal key;
  - acceptance: baseline recorded, change shipped, result recorded after 14 days as worked /
    didn't / inconclusive.

- When the action has an `experiment` spec and the digest a `config`, Do then creates an
  **experiment card** (#986) as the lead (so its prediction is the lead's), linked to the
  ticket. Its hypothesis is "proposal → expected effect" and its metric is the spec plus the
  config, labelled with `metric`. The card measures the baseline when the ticket is done and
  the result after the window; nobody has to remember.

  The lead then gets
  `[SIGNAL DIGEST] The owner chose Do for SD-4 action 1 … Ticket CE-12 is ready in CE site, with experiment card EXP-3: ship the change and close the ticket …`.
  The Slack card shows `✔ Do → CE-12 · EXP-3`.
- Failures are recorded and never block the rest:
  - no project, or the ticket create fails: the card shows why, and the lead is told to
    create the ticket itself;
  - the experiment card fails: the ticket stays, and the lead is told to add the card with
    `experiment-card` before shipping.
- **Skip** is recorded and nobody is messaged.


## API

- `POST /api/signal-digests`: propose (lead, `X-Agent-Session`).
- `POST /api/signal-digests/sources`: a collect run's source statuses `{ site, sources }` (lead).
- `GET /api/signal-digests?site=`: digests, newest first.
- `GET /api/signal-digests/history?site=`: `{ site, entries: [{ key, status: do|skip|open, at, proposal, digestId, ticketId?, blockedUntil? }] }`.
- `GET /api/signal-digests/:id`.
- `POST /api/signal-digests/:id/items/:n` with `{ choice: "do" | "skip" }`: owner only (API token).

## Code

- `backend/src/services/signal-digest/`: contract (validation, history), card (Block Kit),
  store, service, wiring.
- `backend/src/controllers/signal-digest/`.
- `config/skills/team-leader/signal-digest/`:
  - `execute.sh`: collect / propose / schedule;
  - `signal_digest.py`: signals and drafts, importing seo-ops' `seo_ops.py` for config,
    Google auth and Search Console analysis;
  - an example config.
