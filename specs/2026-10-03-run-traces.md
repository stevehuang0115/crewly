# Run traces

Status: implemented on `feat/run-traces` (issue #983, epic #982)

## Problem

A run is logged in eight places: the Request (ticket) file, project ticket
files, the task pool, the message queue, the PTY / in-process turn tracker,
the reply resolver, decision cards, and the token ledger. None of them shares
an id. Diagnosing a run means stitching logs by timestamp, and nothing can
answer "how autonomous was this run?" (#984), "what failed at each stage?"
(#985) or "what did this experiment cost?" (#986).

## Goal

One trace id per unit of work. It is generated where the work starts and
travels with it automatically: no agent has to pass it, no skill changes.

```
request / goal / experiment / owner message   ← trace root (traceId generated)
  → tickets (Request, project ticket)
    → work items (delegate-task, auto-claim, task-pool add, ticket intake)
      → the agent turn that runs it (prompt header + turn context)
        → its skill calls (looked up from the session's current turn)
        → outbound messages, decision cards, guard blocks, errors, usage
      → another agent the turn messages or delegates to
```

Backfill is out of scope: only new work gets a trace.

## Data model

### Trace id

`tr-YYYYMMDD-xxxxxxxx` (UTC date + 8 hex chars). The format is validated
before any path is built from it (`isTraceId`), so an API caller can never
reach a file outside the traces folder.

### Event

One JSON object per line in `<CREWLY_HOME>/traces/<traceId>.jsonl`:

| Field | Meaning |
|---|---|
| `ts` | ISO time |
| `traceId` | The trace |
| `type` | See the table below |
| `actor` | `{ kind: 'owner' \| 'agent' \| 'system', session? }` |
| `refs` | Any of `requestId`, `ticketId` (project ticket or `TKT-n`), `workItemId`, `messageId`, `decisionId`, `skill`, `session` |
| `summary` | Short English text. Secrets redacted, message bodies cut to ~200 chars |
| `outcome` | `ok`, `failed`, `blocked`, `queued`, `skipped` or `info` |
| `data` | Optional flat map of small values (status codes, token counts, the delivery kind) |

### Event types

| Type | Written when | Where |
|---|---|---|
| `trace.root` | A trace starts (first line of every file) | `TraceContext.startTrace` |
| `trace.truncated` | The trace hit its size cap; later events are dropped | `TraceStore` |
| `request.created` | A Request (TKT ticket) is created | `RequestService.create` |
| `request.status` | A Request changes status (submitted for review, accepted, sent back, reopened, cancelled) | `RequestService.update` |
| `ticket.created` | A project ticket is created | `ProjectTicketService.create` |
| `workitem.created` | A work item enters the pool | `PoolStorage.addWorkItem` |
| `workitem.status` | A work item changes status (claimed = `running`) | `PoolStorage.updateWorkItem` |
| `turn.delivered` | A message is written into an agent turn (`data.kind`: `owner_message`, `dispatch`, `redelivery`, `status`, `decision`, `follow_up`, `system`; agent messages also get `message.agent`) | delivery chokepoints |
| `turn.error` | An in-process turn failed | `AgentRegistrationService` |
| `message.agent` | One agent messaged another | HTTP middleware |
| `skill.call` | An agent's skill call to the backend finished (2xx/3xx) | HTTP middleware |
| `guard.block` | A skill call was refused (403/409/423/429) | HTTP middleware |
| `error` | A skill call failed (other 4xx/5xx) | HTTP middleware |
| `message.outbound` | The reply resolver (#954) delivered or refused an agent message | `deliverReply` |
| `status.routed` | A status report was routed (orc / team lead / digest / record) | `OrcStatusRouterService` |
| `decision.created`, `decision.status` | A decision card was asked / changed state | `DecisionStore` |
| `harness.redelivery` | A work-item brief was re-pushed | `WorkItemDispatchSubscriber` |
| `harness.wake` | The reconciler woke an agent for queued work | `ReconcilerService` |
| `harness.correction` | The reconciler corrected a work item | `ReconcilerService` |
| `harness.nudge` | The owner-message watchdog nudged an agent | `OwnerMessageWatchdogService` |
| `usage` | A token-ledger entry was recorded while a turn had a trace | `TokenUsageService` |

### Store

- `traces/<traceId>.jsonl` — append only.
- `traces/index.json` — `{ version, lastSweepAt, traces: { id → entry }, refs: { "<kind>:<id>" → traceId } }`.
  An entry holds the root, `updatedAt`, `eventCount`, `bytes`, `truncated`.
  It is kept in memory and written (atomically) at most once per
  `TRACE_CONSTANTS.INDEX_FLUSH_DELAY_MS`.
- **Bounded size.** A trace takes at most `MAX_EVENTS_PER_TRACE` events and
  `MAX_BYTES_PER_TRACE` bytes. The event that would cross either limit is
  replaced by one `trace.truncated` marker; everything after it is dropped.
- **Retention.** 90 days after a trace's last event its file, index entry and
  refs are deleted. The sweep runs on the first write after boot and then at
  most once a day (piggybacked on writes; no timer). Orphan `.jsonl` files
  older than the retention are removed too.
- **Fire-and-forget.** Every public trace call catches its own errors. Writes
  are chained on one promise; a failed write is logged at debug level and
  counted. A trace failure never fails a turn, a delivery or a request.

## Propagation

### Roots

| Root kind | Where | Actor |
|---|---|---|
| `request` | `RequestService.create` — a ticket from intake, or `POST /api/requests`. A child ticket (`parentTicketId`) joins its parent's trace; a request created by an agent whose turn has a trace joins that trace. | owner (intake) / agent |
| `owner_message` | An owner message (a `[CHAT:…]` delivery) with no trace of its own is remembered as a **pending root** for that session. The root is created only when the turn starts work (creates a work item, project ticket, Request or decision card, or messages another agent). Chit-chat makes no trace. | owner |
| `goal`, `experiment` | `POST /api/traces` and `startTrace()` (for #986's experiment cards) | owner / agent |

### Turn context (`TraceContext`)

Per agent session, in memory:

- `current` — the trace the session's turn is working on;
- a short history of `(since, traceId)` spans, so a usage entry recorded
  after the fact (Claude transcript sync) is attributed by its timestamp;
- the pending owner-message root.

Every delivery into a turn goes through `noteTurnDelivery(session, text)`:
`AgentRegistrationService.sendMessageToAgent` (PTY and in-process) and
`/terminal/:s/write` (PTY message mode and in-process). The trace of the text
is resolved in this order:

1. `[TRACE:<id>]` markers (authoritative);
2. `[TICKET:TKT-n <requestId>]` markers → the Request's trace;
3. work item ids, `D-n` decision ids and project ticket ids (`CE-7`, `TKT-12`)
   found in the text and known to the index.

One trace → it becomes the session's current trace. Several → the current
trace is kept if it is among them, else the first one wins, and the delivery
is recorded in each. None → an owner message clears the current trace and
becomes a pending root; any other delivery (nudges, system notices) keeps it.

### Prompt header

Work-item prompts carry `[TRACE:<id>]` in their header:
`[CREWLY-DISPATCH]` (single and batch), and the direct hand-over
(`/terminal/:s/deliver` with `workItemId`). Status reports routed to the
orchestrator or a team lead carry it as the last line.

### Entities

- **Request**: `traceId` field, set before the first save.
- **Work item**: `traceId` field, set in `addToPool` (and as a fallback in
  `PoolStorage.addWorkItem`) from, in order: an explicit `traceId`; the parent
  / verify-of / source work item; the Request; the project ticket link; the
  creating agent's current turn (materialising a pending owner root). This
  covers delegate-task, task-pool add, ticket intake, project-ticket routing
  and auto-claim (the claimed item already carries it).
- **Project ticket**: the trace lives in the index (`ticket:<id>`), from the
  linked Request or the creating agent's turn. Ticket files are not changed.
- **Decision**: in the index (`decision:<id>`), from its work item, Request,
  project ticket or the asker's turn.
- **Usage**: `TokenUsageEvent.traceId`, from the session's trace at the
  event's timestamp.

### Skill calls

`traceHttpMiddleware` (mounted first in `createApiRoutes`) looks at every
`/api` request that carries `X-Agent-Session`. When that session's turn has a
trace, it records the call on `finish` with `refs.skill = "<METHOD> <path>"`
(ids normalised to `:id`) and the response's `error` text. Hook and polling
paths (`/agent-hooks`, `/traces`, heartbeats) are skipped.

Agent → agent messages (`POST /terminal/:to/write|deliver` in message mode
from an agent session) get `[TRACE:<id>]` appended when the sender's turn has
a trace (materialising a pending owner root), so the receiving turn joins it
however the message is queued.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/traces?since=<ISO>&type=<rootKind>&limit=` | `{ traces: TraceIndexEntry[] }`, newest first |
| `GET /api/traces/by-ref?workItemId=…\|ticketId=…\|requestId=…\|decisionId=…` | `{ traceId, root }` or 404 |
| `GET /api/traces/:id?offset=&limit=` | `{ root, events, total, offset, limit, truncated }` |
| `POST /api/traces` `{ kind: 'goal'\|'experiment', summary, refs? }` | `{ traceId }` (201) |

## Known limits

- Classification of a delivery is by its text. A `[CHAT:…]` delivery that is
  not from the owner (e.g. an agent posting into the orchestrator's chat) is
  treated as an owner message: it clears the session's current trace until
  the next traced delivery.
- The status digest (`[STATUS DIGEST]`) groups reports from several runs and
  carries no marker.
- Turn context is in memory; after a restart a session has no current trace
  until its next traced delivery. Usage synced from transcripts written
  before the restart is not attributed.
- Project tickets and decisions keep their trace only in the index, not in
  their own files.

## For #984 (metrics / timeline)

Everything #984 needs is in the events: wall time (`trace.root` → last event),
delivered turns and their kinds, owner touches (`turn.delivered` with
`kind=owner_message`, `decision.status`), rework (`workitem.status` to
`queued` after `running`, `rejected`, `failed`), interventions
(`harness.*`, `guard.block`), and tokens (`usage` with `data.input`,
`data.output`, `data.model`). Not done here: stall detection and causes,
active-agent time, $ per model, the Timeline UI and the `trace-read` skill.

## Tests

- `trace-store.test.ts`: append/read/paginate, index + refs, size cap with
  marker, retention sweep, write failure swallowed.
- `trace-context.service.test.ts`: marker / ticket / work-item resolution,
  pending owner root materialisation, history lookup by time.
- `trace-recorder.test.ts`: request roots and child tickets, work-item
  inheritance (parent, request, project ticket, creator), decision and
  outbound reply attribution, usage tagging.
- `trace-http.middleware.test.ts`: skill call attributed, guard block,
  agent → agent carry.
- `trace-propagation.test.ts` (real task pool, Request service, dispatcher,
  auto-claim, status router and token ledger): owner request → delegate →
  dispatch header → worker turn → skill call → usage; auto-claim; status-path
  messages to the orchestrator carry the id.
- `trace.controller.test.ts`: list, by-ref, read with pagination, start.
