# Autonomy metrics, run timeline and `trace-read`

Status: implemented on `feat/autonomy-metrics` (issue #984, epic #982).
Builds on run traces (`specs/2026-10-03-run-traces.md`). Consumed by
self-retros (#985).

## Problem

Run traces record what happened in a run, but nothing answers "how
autonomous was it?": how long agents actually worked, how long the run sat
waiting on the owner or on nobody, how often the owner had to step in, how
much rework and harness pushing it took, and what it cost. The owner can't
see a run end to end in the UI, and agents can't read one without pulling
hundreds of raw events into their context.

## What is computed

Everything is computed **per trace, from its events only**
(`backend/src/services/trace/trace-metrics.ts`, pure). Events are sorted by
`ts` first (usage entries can be written after the fact with an earlier
time).

### Time

The run's window is `trace.root` (its `createdAt`) → the last event. Inside
it every moment is put in exactly one bucket, in this priority:

| Bucket | A moment counts here when |
|---|---|
| `activeMs` | an agent turn is busy (any agent) |
| `waitingOwnerMs` | not active, and the owner holds something: a decision card is open (`decision.created` → closing `decision.status`; `parked` still waits on the owner), or the Request is `waiting_confirmation` |
| `waitingAgentMs` | none of the above, and an agent holds something: a work item is open (`workitem.created` → `done` / `done_by_worker` / `verified` / `failed` / `rejected` / `cancelled`), an agent → agent message has not been followed by any activity of its receiver yet, or the Request is `open` / `ready` / `running` / `awaiting_followup` / `blocked` |
| `idleMs` | the rest: nobody holds anything and nobody works |

`wallMs = activeMs + waitingOwnerMs + waitingAgentMs + idleMs`.

**Turn busy periods.** A `turn.ended` event (new, below) gives one busy
period exactly: `[ts − busyMs, ts]`. For a session with no `turn.ended` in the
trace (older traces; turns shorter than `PTY_CONSTANTS.MIN_BUSY_DURATION_MS`)
busy periods are inferred: the deliveries to that session and its own
activity (skill calls, refusals, errors, messages, status reports, usage,
claims) are joined into one period while consecutive points are at most
`TRACE_CONSTANTS.INFERRED_TURN_GAP_MS` (5 min) apart. `time.activeSource`
says which was used (`turn_events`, `inferred`, `mixed`, or `none`).

### Owner touches

| Kind | Counted from |
|---|---|
| `answered` | a decision card resolved or skipped by the owner that is not an approval; an owner message delivered after an agent spoke to the owner (`message.outbound` ok) since the previous owner touch |
| `approved` | a decision resolved by the owner whose card is sensitive (`data.sensitive`) or of kind `spend_cap`, `runtime_terms`, `browser_action`; a Request accepted by the owner (`request.status` → `done` with `acceptedBy=owner`, or `waiting_confirmation` → `done`) |
| `sentBack` | a Request whose `rejectCount` went up, or that went from `waiting_confirmation` back to `open` / `ready` / `running` / `blocked` |
| `corrected` | an owner message delivered while no agent had spoken to the owner since the previous owner touch (unprompted: a correction or a push) |
| `manual` | **Not collected yet.** Would be an `owner.action` (new, below): a dashboard write on an entity of the trace, unless it is the same action as an owner touch above (within `OWNER_ACTION_DEDUPE_MS`, 10 s). The dashboard marker (`X-Crewly-Caller`) is not authenticated, so an agent could fake it: the field is computed but left out of `total`, the UI and the `trace-read` summary until owner sessions (#999) land. |

The owner message that started the trace (within
`ROOT_GRACE_MS`, 2 min, of the root) is the ask, not a touch.

### Rework

| Field | Counted from |
|---|---|
| `sendBacks` | owner send-backs (as above) |
| `retries` | a work item put back to `queued` from another status, or whose `retryCount` went up |
| `failedVerifications` | a work item `done_by_worker` → `rejected` (its lead rejected the work), or a `check` / `review` work item that ended `failed` / `rejected` |
| `subagentSendBacks` | `harness.subagent_sendback` (new, below) |

### Stalls

A stall is a gap longer than `stallMinutes` in which nothing moved: no agent
was busy and there was no progress event. Progress is any event except
`harness.*`, `guard.block`, `error`, `runtime.blocked`, `trace.truncated`,
failed outbound messages and redelivered briefs. `stallMinutes` defaults to
`TRACE_CONSTANTS.STALL_MINUTES` (30); `CREWLY_TRACE_STALL_MINUTES` or
`?stallMinutes=` override it.

Each stall gets one cause, first match wins. "Around the gap" means inside it
or up to `STALL_CAUSE_LOOKBACK_MS` (5 min) before it.

| Cause | When |
|---|---|
| `runtime_quota` | a `runtime.blocked` event, a nudge refused with reason `login` / `spend_cap`, or a `turn.error` naming a usage limit, rate limit, quota, credit or sign-in, around the gap |
| `delivery_failure` | a failed `message.outbound` (refused / not delivered) or a failed `turn.delivered` around the gap |
| `waiting_on_owner` | the owner held something at the gap's start (open decision, Request `waiting_confirmation`), or the last progress before the gap was an agent speaking to the owner and the gap ended with an owner touch |
| `waiting_on_agent` | an agent held something at the gap's start (as in `waitingAgentMs`); `detail` names the agent |
| `nobody_pushing` | none of the above |

A trace that is still open (an open work item, decision or non-terminal
Request) with no event for longer than `stallMinutes` up to now has an
**ongoing** stall (`ongoing: true`), from its last event to now. Its time is
not in `wallMs` (the window ends at the last event) but is in
`stalls.totalMs`.

### Harness interventions

`nudges` (`harness.nudge`), `redeliveries` (`harness.redelivery`), `wakes`
(`harness.wake`), `corrections` (`harness.correction`), `guardBlocks`
(`guard.block`), `misroutes` (failed `message.outbound`: refused or
undelivered agent messages).

### Tokens and cost

`usage` events, summed by agent session and by model, with the token unit of
`eventTokens` (input incl. cached + output) and the cost of `eventCostUsd`
(`token-usage.service.ts`) — the same numbers as the Usage page.

### Outcome

- `request`: the last Request status (`request.created` / `request.status`).
- `workItems`: total / done / failed / open, from each item's last status.
- `experiment`: id, status (`created` → planned, `shipped` → running,
  `measured` → done, `cancelled`) and verdict (from the `measured` entry).
- `state`: `done`, `cancelled`, `failed`, `waiting_on_owner`, `in_progress`
  or `no_open_work` (nothing open and nothing finished, e.g. an owner-message
  trace that was answered).

## New events (additive)

| Type | Written when | Where |
|---|---|---|
| `turn.ended` | an agent turn that started while the session was on a trace ended; `data.busyMs` (only turns ≥ `MIN_BUSY_DURATION_MS`) | `TraceContext.noteTurnActivity`, fed by `ActivityMonitorService.onWorkingStatusChange` (PTY) and the in-process turn's start / `finally` |
| `runtime.blocked` | a runtime ran out of usage / credit, or an account's login expired, for a session on a trace; `data.reason` = `usage_limit` / `billing` / `login` | `RuntimeFallbackService.onUsageLimit` / `onAccountSignedOut` |
| `harness.subagent_sendback` | the subagent guard sent a no-op subagent back (#852) | the hook posts (in the background, `& disown`: the stop never waits) `{event:"SubagentSendBack"}` to `POST /api/agent-hooks`; the controller records it in the session's trace |
| `owner.action` | a dashboard write (`X-Crewly-Caller: dashboard`, no agent session; POST/PUT/PATCH/DELETE, < 400) whose path names an entity the trace index knows (work item, Request, ticket, decision, experiment) | `traceHttpMiddleware` |

`usage` events also carry `cacheWrite` now, so the trace's cost matches the
ledger's for Claude Code turns.

## API (read-only, under `/api/traces`)

| Endpoint | Returns |
|---|---|
| `GET /api/traces?…&metrics=0\|1` | as before; each entry also has `metrics` (a `TraceMetricsSummary`: wall, active, waiting on owner, owner touches, rework, stalls, interventions, tokens, cost, outcome state) unless `metrics=0`. With metrics, at most `METRICS_LIST_MAX` (100) rows |
| `GET /api/traces/:id/metrics?stallMinutes=` | `TraceMetrics` |
| `GET /api/traces/:id/timeline?stallMinutes=` | `{ root, metrics, groups, truncated }` — the timeline grouped by turn and agent, with stalls as their own groups |
| `GET /api/traces/:id/summary?maxChars=&stallMinutes=` | `{ text, metrics, links }` — the compact summary `trace-read` prints, at most `maxChars` (default `READ_DEFAULT_CHARS` 4 000, max `READ_MAX_CHARS` 16 000) |

Metrics are cached per trace (keyed by event count, last event and
`stallMinutes`) for `METRICS_CACHE_TTL_MS` (60 s, so an ongoing stall keeps
growing). The cache holds `METRICS_CACHE_MAX` (1 000 ≥ `MAX_LIST_LIMIT`)
traces, so one list call never evicts its own rows. A trace is read with
`TraceStore.readAll`: one file read and one parse serve the events and the
metrics of a `/timeline` or `/summary` call.

### Timeline groups

Events are walked in time order:

- a delivery to a session (`turn.delivered`) starts a **turn** group for it;
- an event about a session (its actor, or `refs.session` for harness and
  system events) joins that session's latest group, unless more than
  `stallMinutes` passed since that group's last event;
- other owner events form **owner** groups, other system events **system**
  groups (consecutive ones merged);
- each stall is a **stall** group at its time.

A group has a title ("Owner → Ella", "Work item brief → Sam"), its time span,
counts (events, skill calls, refusals, errors), tokens and cost, its worst
outcome, and its events.

## UI

`components/TraceTimeline/` (`@crewly/ui` only: `CompactRow`,
`StatusLabel`, `UnderlineTabs`, `EmptyState`; tokens only):

- **Metrics strip**: Wall · Active · Waiting on you · Owner touches · Rework
  · Stalls · Cost, one line on desktop, a 2-column grid on a phone.
- **Polling**: an unfinished run reloads every 30 s; the interval doubles
  each time nothing changed (event count and last event), up to 5 min, and
  polling stops while the browser tab is hidden (it reloads when it shows).
- **Timeline**: one vertical list of groups. Each row: who, what, when,
  counts; click to expand the events. Stall rows use the attention colour and
  say the cause ("Stalled 2h 10m — waiting on you: decision D-12 open").

Where it shows:

- Request detail (`/tickets/requests/:id`): tabs **Overview · Timeline**
  (`?tab=timeline`). The trace is the Request's `traceId`, else looked up by
  `requestId`.
- Tickets › **Experiments** (new tab, `?tab=experiments`): the experiment
  cards; a card opens `/tickets/experiments/:id` with tabs **Overview ·
  Timeline** (card, metric, baseline, result, verdict, card timeline / the
  run timeline). When experiments are not running (503: starting up, or
  `CREWLY_EXPERIMENTS=0`) the tab shows an empty state, not the error.
- `/tickets/traces/:traceId`: any trace's timeline (the link `trace-read`
  and retros give for traces with no Request or experiment).

## `trace-read` skill

`config/skills/agent/core/trace-read/execute.sh` — for team leads and the
orchestrator (and any agent reviewing its own run).

```bash
bash execute.sh --trace tr-20261003-ab12cd34
bash execute.sh --work-item <uuid> | --ticket CE-7 | --ticket TKT-12 | --request <id> | --experiment EXP-3
bash execute.sh --since 2026-10-01T00:00:00Z [--limit 10]     # recent runs, one line each
  [--max-chars 4000] [--stall-minutes 30] [--json]
```

One trace → the summary: header (root, outcome), time, owner touches, rework,
interventions, tokens and cost by agent and model, stalls with causes, the
key events (state changes, refusals, errors, interventions, owner touches;
never routine skill calls or usage lines) and links (UI page, API). The
backend builds it within `--max-chars`; the script also cuts its output at
that size. `--since` lists traces active since then with their metrics
summary, newest first (`--limit` at most 100).

## Tests

- `trace-metrics.test.ts`: synthetic traces — time buckets, turn events vs
  inferred, each owner touch kind, rework, each stall cause, ongoing stall,
  interventions, tokens and cost by agent and model, outcome.
- `trace-timeline.test.ts`, `trace-summary.test.ts`: grouping, stall groups,
  key-event selection, the size bound.
- `trace-analysis.service.test.ts`: read-all + cache.
- `trace.controller.test.ts`: the new endpoints and the embedded list metrics.
- Recorder / context / middleware / hooks tests for the new events.
- `trace-read/execute.test.ts`: argument → endpoint mapping and the output
  size bound against a stub backend.
- Frontend: metrics strip, timeline rows (expand, stall highlight), the
  Request detail tab, the experiments list and detail.
