# Ticket Loop (2026-09-24)

Owner-approved plan: https://claude.ai/code/artifact/7247657a-63c9-426b-adb6-57e15a196ab1
(Chinese, "Crewly Ticket Loop 方案"). This file is the engineering spec; the doc is
the product plan. Four phases, each released on its own.

## Why

Measured on the owner's Mac, 2026-09-24:

- **Intake is broken.** Requests are only created by the legacy chat endpoint
  (`controllers/chat/chat.controller.ts`) and the legacy Slack → orchestrator
  bridge (`services/slack/slack-orchestrator-bridge.ts`). Team channels, per-agent
  Slack DMs, chat-v2, the portal and the phone create none. Seven days: 3 Requests,
  all hand-made.
- **Nothing links.** `WorkItem.requestId` is almost always empty.
- **Review piles on the orc.** Every worker WorkItem spawns a `review` WorkItem
  targeted at `crewly-orc` (event-to-workitem-bridge). 7 days: 191 WorkItems, 109
  delegate + 82 review, all 82 on the orc; 40+ stale queued.
- **Nothing closes.** 882 WorkItems in `~/.crewly/task-pool/pool.json`, 826
  non-terminal, hundreds `verified` since May.
- **Direct asks leave no trace.** Asking an agent in a DM produces no record.

## Owner decisions (defaults the owner accepted by approving the plan)

1. Every "please do X" becomes a ticket automatically; a one-tap "don't track" undoes it.
2. Cron- and Mission-triggered tickets auto-close when self-check passes; other
   no-review types are configurable.
3. Phase 1: only the owner files tickets (other humans later).
4. Tickets live on the machine that owns the project; portal and phone read via relay.
5. SteamFun keeps its own board.

## Model

A ticket **is** a `Request` (`types/v2/request.types.ts`) with added fields — no
new store. Storage stays `{projectDataDir}/.crewly/requests/{id}.json`.

| Field | Type | Notes |
|---|---|---|
| `ticketNumber` | number | Monotonic per data dir; displayed `TKT-{n}` (zero-pad 3) |
| `kind` | `'issue' \| 'feature' \| 'idea'` | Default `feature`; 🐛 → `issue`; `ticket-idea` → `idea` |
| `origin` | `{ channel: 'slack-channel' \| 'slack-dm' \| 'chat' \| 'portal' \| 'mobile' \| 'bug-button' \| 'agent' \| 'cron' \| 'mission' \| 'legacy'; ref: string; threadRef?: string; author: string; authorName?: string }` | Where it was said and by whom; replies go back to `threadRef` |
| `assignee` | string? | Agent session that owns it (pre-filled for a DM) |
| `acceptance` | `{ text: string; selfCheck?: 'pass' \| 'fail'; evidence?: string }[]` | Phase 2 surfaces it |
| `rejectCount`, `submitCount` | number | Phase 2 |
| `board` | derived | See status mapping |

Existing fields stay. `priority` keeps `low|normal|high` internally and maps to
P3/P2/P1; add `urgent` → P0.

### Board status (derived, never stored separately)

| Board column | From Request status / WorkItems |
|---|---|
| 想法 Idea | `kind === 'idea'` and status `open` |
| 待处理 To do | `open`, `ready` |
| 进行中 In progress | `running` |
| 阻塞 Blocked | `blocked` or `waiting_confirmation` |
| 待验收 To review | all WorkItems terminal-success and `requiresConfirmation` (Phase 2 sets it) |
| 已完成 Done | `done` (`cancelled` hidden, searchable) |

## Phase 1 — intake and linking (this PR)

### 1. `TicketIntakeService` (new, `services/v3/ticket-intake.service.ts`)

One entry point: `intake(message: IntakeMessage): Promise<Request | null>`.

- `IntakeMessage` = `{ text, origin, attachments?, isOwner: boolean, targetAgent?: string }`.
- Only owner messages (`isOwner`) create tickets in Phase 1; agent-authored text never does.
- Reuse the existing suppression rules from `SlackOrchestratorBridge.shouldSuppressAutoRequest`
  (continuations, file-only, trivial acks) — move them into the intake service so every
  channel uses the same gate. Add: messages in a thread that already has an open ticket
  append to that ticket's discussion instead of opening a new one.
- Dedupe by `origin.ref` (`findBySourceConversationItemId`).
- Classify with the existing `classifyIntent` / `generateRequestTitle`; `query` intent
  (a question, not a task) does not open a ticket.
- Emits `request:created` as today (decompose + SLA subscribers keep working).
- Returns the ticket so the caller can post the receipt.

### 2. Wire every channel

| Channel | Hook point | Receipt |
|---|---|---|
| Slack team channel / shared room | `SlackTeamChannelService.routeInbound` (owner messages) | Thread reply "已记成 TKT-123 · 不用记" (block button) |
| Slack agent DM | `SlackAgentDmService` inbound | Same, in the DM thread |
| chat-v2 | chat-v2 message create for owner-authored messages | System message under it |
| Portal / mobile | relay → chat-v2 path (covered by chat-v2) | Same |
| Legacy chat + legacy Slack bridge | replace their inline `requestSvc.create` with `intake()` | unchanged |

"不用记" (don't track) cancels the ticket (`status: 'cancelled'`, tag `dismissed`) and
edits the receipt to "已取消记录".

### 3. Link work to tickets

- `TaskPoolService.addToPool`: when `requestId` is absent and the creating agent's
  current in-flight turn (safe-restart `InFlightTurnTracker`) came from a message that
  has a ticket, set `requestId` to that ticket. Record the mapping message → ticket when
  intake runs.
- Skills that create WorkItems (`delegate-task`, `create-task`, …) accept `--request-id`
  and pass it through; the prompt's `[TICKET:TKT-123 <id>]` marker (added to the
  delivered message when it has a ticket) tells agents which id to use.
- Request `workItemIds` stays maintained by the existing `workitem:queued → linkWorkItem`.

### 4. One-time archive (migration)

On boot, once (marker file `task-pool/.archived-2026-09-ticket-loop`):
move every WorkItem that is `verified`/`done`/`failed`/`cancelled` and older than 7 days,
plus `queued` review items older than 7 days, into
`task-pool/archive/pool-archive-YYYY-MM-DD.json`. The live pool keeps the rest.
Log counts. Never delete; archive is append-only.

### 5. API

- `GET /api/tickets?column=&q=&kind=&includeLegacy=` — board-shaped list (Phase 2 UI uses it).
  Returns `{ tickets, columns }`; cancelled hidden unless `column=cancelled`;
  Requests from before the ticket loop (no number) only with `includeLegacy=true`.
- `GET /api/tickets/:tkt` — by `TKT-123`, `123` or id.
- `POST /api/tickets/:id/dismiss` — the "不用记" action.

### Phase 1 as built (implementation notes)

Code: `services/v3/ticket-intake.service.ts` (intake, gate, counter, dismiss,
list), `services/v3/ticket-channel-hooks.ts` (refs, owner test, delivery line,
receipt sinks, per-channel intake builders), `types/v2/ticket.types.ts`,
`services/task-pool/pool-archive-migration.ts`, `controllers/tickets/`.

- **Numbering.** `requests/.ticket-counter` (no `.json`, so `listAll` never
  reads it), updated with `modifyJsonFile` under a lock; intake is also
  serialised in-process. Seeded from — and never below — the highest
  `ticketNumber` on disk, so a lost counter file cannot reuse a number.
- **Owner only.** chat-v2: `senderType === 'user'` with no
  `authorAgentSession` / `remoteAgentSession` marker and no agent-reply
  source (the #786 rule). Legacy chat: no `X-Agent-Session`. Slack: no
  `authorAgentSession`, and — when the Cloud app's installer is known — the
  author must be that user (other people in the workspace do not file tickets
  in Phase 1; self-hosted socket mode, installer unknown, = any human).
- **Gate.** Trivial acks, file-only, `query` / `L0` intent, duplicates, and
  follow-ups (append to the thread's open ticket's `discussion`). Length gate
  counts CJK characters twice (the old 12-char gate dropped most Chinese asks:
  「把首页改成蓝色」 is 7 characters). A thread whose ticket was dismissed
  stays quiet; a thread whose ticket is `done` may open a new one.
- **Source ids.** Legacy bridge keeps `slack-<ch>-<root>[-msg-<ts>]` and the
  `slack` tag (SLA unchanged) — the `slack` tag only when the orchestrator is
  the one answering. Team channels use `slackch-…`, agent DMs `slackdm-…`,
  non-orc chat-v2 `chatv2t-…`: the SLA subscriber closes any open Request whose
  source starts with `slack-` / `chatv2-` on the next reply in that thread, and
  must not do that to tickets. Orc-DM chat-v2 keeps `chatv2-` + `chat-v2` tag.
- **Decompose.** Skips a ticket whose `assignee` is an agent other than the
  orchestrator (that agent plans it); orc tickets decompose as before.
- **Shared rooms.** Every machine sees a shared-room message; only the machine
  that owns it files the ticket: a team channel's own machine, or in an ad-hoc
  room the machine whose agent is @'d / handed it / must answer.
- **Receipts.** One per ticket (posted only on `created`), in the same thread,
  after intake returns (delivery never waits on Slack). Slack: through
  SlackService — the workspace bot in team channels / legacy bridge, the
  agent's own bot in its DMs and in private ad-hoc rooms. Text:
  「已记成 TKT-012 · 不用记？回复「不用记」」. A Block Kit 不用记 button is added
  only in socket mode (`supportsInteractivity()`): on the Cloud transport Slack
  sends button clicks to Cloud, which does not relay them. chat-v2: a
  `system_note` row under the owner's message with
  `metadata.ticketReceipt = { ticketId, tkt, status, dismissPath }`.
- **不用记.** A reply 「不用记」 (or 别记 / don't track …) in the thread — or
  top-level within 30 min in the same conversation — or
  `POST /api/tickets/:id/dismiss` (owner only: refused with
  `X-Agent-Session`), or the socket-mode button. Cancels + tags `dismissed`,
  edits the receipt to 「TKT-012 已取消记录」 (Slack `chat.update`, chat-v2
  `updateSystemMessage`). A receipt that lands after the dismissal is edited
  as soon as it lands.
- **Linking.** Delivered copies carry
  `[TICKET:TKT-012 <id>] …加上 --request-id <id>`: chat-v2 via
  `metadata.ticketMarker` rendered by the dispatcher (the stored row is not
  changed), queue deliveries (legacy chat / bridge) appended to the text.
  `addToPool(wi, { creatorSession })` — the controller passes
  `X-Agent-Session` — fills `requestId` from the markers in that session's
  in-flight turn when exactly one ticket is referenced (two tickets in one
  turn = ambiguous = not linked), and records
  `metadata.requestIdSource = 'in-flight-turn'`. The marker in the delivered
  text *is* the message → ticket mapping, so it survives restarts with the
  tracker's own state. `--request-id` accepts the id or `TKT-123`
  (`/task-pool/add` resolves it; unknown → 400 `unknown_ticket`) on
  `create-task`, `team-leader/delegate-task`, `team-leader/decompose-goal`
  (and `orchestrator/delegate-task`, `break-down-request`, which had it).
- **Mobile / portal.** chat-v2 REST from the phone relay carries
  `X-Crewly-Client: mobile` → origin `mobile`; the portal relay RPC →
  `portal`. `/tickets` GET and `/tickets/…/dismiss` POST are on the mobile
  relay allowlist.
- **Archive.** Runs on boot through the pool's own `PoolStorage` cache (a
  later debounced flush cannot write archived items back). Archive written
  first, merged by id (append-only; an unreadable existing archive is never
  overwritten — a new file is written beside it), then items leave the pool,
  then the marker. Claims are left as they are. Items with no parseable date
  are kept. Counts are logged and stored in the marker.

### Out of scope for Phase 1

Board UI, acceptance editing, verify/reject, agent self-claiming, review routing,
bug button, delivery hooks (Phases 2–4).

## Phases 2–4 (summary; specced when started)

2. Board (Crewly dashboard, portal, mobile), acceptance criteria, 验过了 / 打回 with a
   required reason, review in the Slack thread, push with the two actions.
3. Agents self-claim by priority (own rejected → own unblocked → queue rejected → P0..P3),
   one ticket per agent with a lock; review routing (self-check → team lead → owner),
   orc stops reviewing every WorkItem; 30-day archive of done tickets.
4. Per-project delivery hooks (PR / preview / release commands), 🐛 screenshot button in
   dashboard + portal, `ticket-idea` skill.
