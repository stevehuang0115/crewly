# Autopilot experiments: traced runs, stats, experiment scope, daily retro

Status: implemented on `feat/autopilot-experiment-tracking` (epic #982; minimal #985).
Builds on: ticket autopilot (`specs/2026-09-30-ticket-autopilot.md`), run traces
(`specs/2026-10-03-run-traces.md`), autonomy metrics
(`specs/2026-10-03-autonomy-metrics.md`) and experiment cards (#986).

## Problem

The owner is about to let a project's ticket autopilot drive a feature (first
case: CE's `/feed` on visa.careerengine.us). He needs to answer two questions
afterwards, from data and not from memory:

1. **Did the feature move the business number?** (GA4 / Search Console)
2. **How autonomous was the run?** Tickets shipped, how often he had to step
   in, where it stalled and why, what it cost.

Today neither is answerable. The autopilot's own decisions (triage, skips,
budget pauses) are only debug logs. A ticket started by a lead in an
autopilot triage usually has no trace at all (it has no Request and the
triage item was untraced), so its turns, owner touches and cost are lost.
Ticket status changes are not traced. Experiment cards measure one metric
around a single ship time; nothing measures a *period of autopilot work*.

## 1. Autopilot runs are traced and labelled

### New trace vocabulary (additive)

| Kind | Name | Meaning |
|---|---|---|
| root kind | `autopilot` | The **run trace** of one project for one local day |
| root kind | `ticket` | A project ticket started by the autopilot that had no trace yet |
| root kind | `triage` | One triage turn of the driver (tagged; kept out of the run trace's event cap) |
| event | `autopilot.action` | One autopilot step; `data.action` says which (table below) |
| event | `ticket.status` | A project ticket changed status (`data.from`, `data.to`) |
| index ref | `autopilotRun:<projectId>:<YYYY-MM-DD>` | The run trace of a project/day |

Index entries gain optional **tags**:

```ts
tags?: {
  autopilot?: { projectId: string; day: string }; // set once, first tag wins
  labels?: string[];                               // ticket labels, merged (max 20)
}
```

`TraceStore.tag(traceId, tags)` merges them; `TraceStore.list` and the new
`TraceStore.listTagged` filter by `autopilotProjectId`, `day` and `label`.
`GET /api/traces` accepts `?autopilotProject=&day=&label=`.

### The run trace

One per project per local day (the day the budget uses), started on the
first autopilot step of the day, tagged `autopilot: {projectId, day}`. Its
`autopilot.action` events:

| `data.action` | When | Where |
|---|---|---|
| `triage` | The driver was woken with a triage item (`data.tickets`, `data.count`, `data.trigger`, `refs.workItemId`) | `evaluateProject` |
| `triage_ticket` | A ticket was listed in a triage for the first time that day (`refs.ticketId`, `data.labels`) | `evaluateProject` |
| `skip` | No triage, with `data.reason` (`budget_reached`, `triage_in_flight`, `nothing_to_triage`, `nobody_idle`, `too_soon`, `no_driver`). Recorded only when the reason differs from the previous skip of that project that day, so the 5-minute tick cannot flood the trace | `evaluateProject` |
| `budget_paused` / `budget_resumed` | The day's spend crossed the budget / came back under it (a boost) or the day rolled over (`data.reason`: `boost` / `new_day`) | `evaluateProject` |
| `pick` | A lead moved a ticket to `ready` in an autopilot project | ticket status listener |
| `cancel` | A lead / orchestrator cancelled a ticket in an autopilot project | ticket status listener |
| `claim` / `dispatch` | A member claimed a ready ticket (AutoClaim or `claim`) / a lead assigned one and its WorkItem was queued | `ProjectTicketWorkflowService.startWork` |
| `retro_scheduled` / `retro_filed` / `retro_gap_ticket` | Daily retro (§4) | retro |

The triage WorkItem runs in its own `triage` trace (tagged with the project
and day), so the driver's turn, its skill calls and its usage are measured
without eating the run trace's event cap. A skip never starts a run trace:
a day with nothing but skips (or with only a budget notice) is not a run.
Each skip reason is traced at most once per project per day.

### Ticket traces

When work starts on a ticket of a project whose autopilot is **on**
(`startWork`: AutoClaim, `claim`, `assign`):

1. The ticket's trace is resolved: the index's `ticket:<id>` (e.g. from its
   Request), else a new `ticket` root (`<ID>: <title>`).
2. It is tagged `autopilot: {projectId, day}` (day = the start day) and the
   ticket's labels.
3. The ticket's WorkItem gets that trace id before it enters the pool, so
   the worker's turns, usage, verification and owner touches land in it.
4. `autopilot.action claim|dispatch` is recorded in the ticket trace and in
   the day's run trace.

From then on every status change of the ticket (`ProjectTicketService.mutate`
notifies listeners when status or labels change) is recorded as
`ticket.status` in its trace, and new labels are merged into its tags. Projects
with the autopilot off are untouched.

### Runs API

`GET /api/project-ticket-autopilot/:project/runs?days=N&label=` (owner,
orchestrator, or a lead of a project team) →

```ts
{ project, days: [{ day, runTraceId | null, traces: [{ traceId, kind, summary, ticketId?, labels, updatedAt }] }] }
```

newest day first; a ticket trace is listed under the day it started.

## 2. Autopilot stats

`GET /api/project-ticket-autopilot/:project/stats?days=N&label=&stallMinutes=`
(same callers; `days` 1–90, default 14). Built on the trace events and the
#984 metrics of every trace tagged with the project in the window.

Per day (local) and in total:

| Field | Definition |
|---|---|
| `triaged` | Distinct tickets in `triage_ticket` events |
| `started` | Distinct tickets with `ticket.status → in_progress` |
| `done` | Distinct tickets whose WorkItem reached `done_by_worker` / `done` (the worker finished) |
| `verified` | Distinct tickets with `ticket.status → done` (lead verified; owner accepted a review) |
| `sentBack` | Lead rejected the work (`done_by_worker → rejected`), owner sent a review back (`review → ready`), or a done ticket was reopened (`done → ready`) |
| `stalled` | Distinct tickets with a stall (autonomy-metrics definition) starting that day |
| `cycleTime` | Median and mean ms from the first start to done, and to verified (tickets that got there in the window) |
| `ownerTouches` | `{answered, approved, sentBack, corrected, total}`: each touch on the day it happened (#984 metrics computed with `detail`, which lists every touch with its time) |
| `stalls` | `{count, totalMs, byCause: {cause: {count, ms}}}`: each stall on the day it started (`detail` keeps every stall) |
| `interventions` | `{nudges, redeliveries, wakes, corrections, guardBlocks, misroutes, total}` (the #984 definitions), by the event's day |
| `tokens` / `costUsd` | `usage` events of the run and ticket traces, by the event's day (`eventTokens` / `eventCostUsd`) |
| `budget` | `{dailyBudgetTokens, ledgerTokens, ledgerCostUsd, pct}`: the token ledger of the project's team sessions for that day — the same number the budget brake uses — against today's configured budget |
| `pausedMs` | Time paused on the budget: `budget_paused` → `budget_resumed`, an open pause running to the end of its day (or now) |

With `label`, ticket counts, cycle times, touches, stalls, interventions and
traced tokens are limited to ticket traces carrying the label (and the run
trace's `triage_ticket` events with it); `budget` and `pausedMs` stay
project-wide (the budget is project-wide) and say so (`scope: 'project'`).
`labels` lists every label seen, for the UI's filter.

Everything counts by event time, so adjacent windows never double count. A
ticket trace counts only from the autopilot's first claim / dispatch of it
(a reused Request trace's earlier conversation is not the autopilot's).
Day ends are the next local midnight (DST-safe). `traceCount` is the number
of traces in the range (0 = no autopilot data); `incomplete` is set when a
trace could not be read, and an unreadable trace index is an error, never an
empty range.

**Access.** The stats and runs need the owner, the orchestrator or a lead
of the project. Autopilot-tagged traces may be read by the owner and the
orchestrator (let through before any project lookup, so a deleted or
renamed project's traces stay readable), members of the project's teams
(the rule decision cards use for tickets), and any agent that took part in
the trace (the ticket's assignee, the agents of a reused Request trace):

- `GET /api/traces?autopilotProject=` and `/api/traces/:id…`: 401 / 403 otherwise;
- plain `GET /api/traces`: tagged rows the caller may not read are left out;
- `GET /api/traces/by-ref`: such a row keeps its id but loses its summary;
- `label` / `day` filters without `autopilotProject`: owner / orchestrator only.

Untagged traces are unchanged everywhere.

### UI: project page › Autopilot tab

`/projects/:id?tab=autopilot` (`@crewly/ui` only, tokens only, simplify rules):

- **Headline**: one sentence ("Last 14 days: 9 tickets shipped · 1.2 owner
  touches per ticket · $3.10 per shipped ticket") and a status label (On /
  Off / Paused on budget today).
- **Per-day bar chart**: shipped (verified) tickets per day, a thin bar per
  day; hover/title gives started / done / sent back / cost. Days scroll
  horizontally inside the card, never the page.
- **Top stall causes**: up to 3 causes with count and time.
- **Runs**: one `CompactRow` per day (shipped, cost, paused) linking to the
  run trace's timeline, and its ticket traces behind `ShowAll`.
- **Label filter** (`FilterButton`, single choice) from `labels`.
- Range 7 / 14 / 30 days (`UnderlineTabs`-sized segmented buttons).
- Empty state when the autopilot is off and there is no data.
- Works at 390px: a 2-column number grid, wrapping rows.

## 3. Autopilot experiments

An experiment card can now measure a period of autopilot work on a project:

```bash
bash execute.sh create --autopilot --project <id> [--label feed] [--started-at ISO] \
  --hypothesis "…" --source ga4 --measure events --event feed_card_click --channel all \
  --config /abs/ce.seo-ops.json \
  --metric "ga4:sessions:page=/feed,pageMatch=contains,channel=all" \
  --metric "gsc:clicks:page=/feed,pageMatch=contains" [--window-days 14]
```

Body: `autopilot: { project, label? }`, `metrics?: ExperimentMetric[]` (extra
outcome metrics, same config unless given), `startedAt?`.

- **Start** = `startedAt`, else the card's creation. The card ships at
  start. Outcome metrics use the existing windows (`experimentWindows`, UTC
  days with the source's lag). Process windows are **local days**: the
  observation window starts on the start day (the autopilot works that day
  too) and runs `windowDays` days; the baseline is the equal window right
  before it.
- **Outcome metrics** via seo-ops: the primary `metric` gives the verdict
  (existing rules); each extra metric gets its own baseline, result and
  verdict line. An extra metric's failed fetch is recorded and retried, never
  blocks the primary.
- **Process metrics** from the autopilot stats over the process windows (with
  the label), recorded on their own schedule: the baseline at start, the
  result once the observation window's last local day is over, whatever the
  outcome fetches do. A window with no autopilot traces is stored as
  `noData` (shown as "no autopilot work", and a no-data baseline is left out
  of the result); a failed read is retried, never stored as zeros:
  `{ticketsShipped, ticketsDone, ticketsStarted, ownerTouches,
  ownerTouchesPerTicket, stallMs, stalls, costUsd, costPerShippedTicket,
  tokens, pausedMs, interventions}`.
- **Result** = the outcome verdict plus a process summary: tickets shipped,
  owner touches per ticket, stall time, $ per shipped ticket (baseline →
  result when the baseline had autopilot work).
- **Stuck outcome fetch** (e.g. missing credentials): the owner is told once
  after 6 failures (as before) and, for autopilot cards, reminded at most
  once a week while it keeps failing, with the process so far.
- **Weekly check-in**: every 7 days after start while running, ONE short
  owner note (Slack owner path): process so far and the primary metric so far
  (best effort; a fetch failure just leaves it out). Recorded as `check_in`.
- **Timeline**: `autopilot_scope`, `shipped`, `baseline_captured`,
  `outcome_baseline`, `process_baseline`, `check_in`, `measured`,
  `outcome_result`, `process_result`, … — all mirrored into the card's trace.
- While a card is `running` with an autopilot scope, the project's daily
  retro defaults to on (§4).

## 4. Daily autopilot retro (minimal #985)

Per project, opt-in: `ticketAutopilot.retro: true | false` (absent = on
while an autopilot experiment on the project is running, else off).
`project-tickets autopilot --project P --retro on|off|default`.

- **Backoff.** A retro whose stats reads fail is retried after 30 min,
  doubling up to a day; the same for a weekly check-in whose process read
  or send fails (no check-in is sent without process numbers).
- **Schedule.** The autopilot tick, once per project per local day at or
  after `RETRO_HOUR_LOCAL` (09:00), for the previous day, when that day had
  real autopilot work (tickets triaged, started, done or verified).
  Scheduling is recorded in the reviewed day's run trace only. It creates ONE
  `autopilot_retro` WorkItem for the driver (traced on the reviewed day's run
  trace), skipped while a retro item of the project is still live.
- **Brief.** The day's stats in a few lines, the traces of that day with
  their `trace-read` commands, the four classes, and the submit command.
- **Submit.** `project-tickets retro --project P --day D --summary "…"
  --problem "harness_gap|Title|detail|evidence" …` →
  `POST /api/project-ticket-autopilot/:project/retro`
  `{ day, summary, problems: [{ class, title, detail?, evidence? }] }`
  (driver, a lead of the project, orchestrator or owner; one at a time; a
  future day is refused). Classes:
  `agent_judgment`, `missing_skill`, `harness_gap`, `owner_dependency`.
- **The harness then:**
  1. writes the retro (what shipped, where it stalled and why, the problems
     by class, with the day's numbers) to the project wiki at
     `llm-curated/autopilot-retros/<day>.md`;
  2. records `retro_filed` in the run trace;
  3. turns `harness_gap` problems into tickets on the **Crewly** project
     (`TICKET_AUTOPILOT_CONSTANTS.RETRO_HARNESS_PROJECT`), in `backlog`,
     labelled `harness-gap`, `from-retro` and **`retro-pending`** — held: the
     triage never lists a `retro-pending` ticket; only this card's answer
     lifts the hold (not `ask-owner --clear`, not other decisions), and the
     digest does not list it as waiting on the owner. Deduped against open tickets of
     that project and gaps filed by earlier retros (normalised title, word
     overlap ≥ 0.6); at most `RETRO_MAX_GAPS_PER_DAY` (3) per day across
     projects;
  4. asks ONE system decision card (kind `retro_harness_gaps`) for all the
     tickets it filed: **Approve** (the hold is removed and they move to
     `ready` for the Crewly team) or **Skip** (cancelled — only tickets that
     have not started; a started one is left with a Log line and the lead of
     its project gets a `notify` WorkItem to decide). The default at
     the deadline is Skip. When the card cannot be asked, the tickets are
     cancelled at once. The card's handler is registered even with the
     autopilot switched off.

## Measuring CE

Checked on 2026-10-02 (owner's Mac, read only):

- seo-ops site config: `ce-core/.crewly/seo-ops/seo-ops.config.json` —
  `siteUrl` `https://visa.careerengine.us`, `gscProperty`
  `sc-domain:visa.careerengine.us`, `ga4PropertyId` `392584672`.
  `ga4HostName` is not set (the property may count other hostnames).
- `credentialsPath` is `SEO_OPS_GOOGLE_CREDENTIALS`, and that variable is
  **not set** in the running backend's environment (nor in the shell rc
  files), so every metric fetch fails until it is.
- `/feed` is `robots: noindex` and not in the nav (step 1), so Search Console
  clicks for it are expected to be ~0; GSC is not a usable outcome metric
  until launch.
- GA4: the page fires `feed_card_click` (`card_type`, `category`,
  `position`) on every card click — usable with `--measure events --event
  feed_card_click --channel all`. GA4 sessions can only be filtered by
  **landing** page in seo-ops (sessions that *started* on `/feed`).
  Whether GA4 has received any `feed_card_click` yet could not be checked
  (no credentials in reach).
- Labels: of 97 CE tickets only one carries `feed`; `--label feed` counts
  only labelled tickets, so the lead must label the feed tickets.

## Tests

- `ticket-autopilot-trace.test.ts`: run trace per project/day, skip dedupe,
  ticket trace creation / reuse / tagging, labels flow, status events.
- `ticket-autopilot-stats.test.ts`: stats on synthetic traces (each count,
  cycle times, touches, stalls by cause, paused time, label filter).
- `ticket-autopilot.service.test.ts`: triage traced, budget pause/resume
  events, retro scheduling once per day, retro default with a running
  experiment, retro submit (wiki, dedupe, cap, one card).
- `experiment.service.test.ts`: autopilot create (ships at start), baseline
  with extra metrics and process, result with process summary, weekly
  check-in, mocked seo-ops.
- `trace-store.test.ts`: tags and tag filters.
- Frontend: `AutopilotTab.test.tsx`.
