# Drive mode v3: status first, secretary, two-phase replies, keep-warm

Date: 2026-10-09. Builds on `2026-10-08-drive-mode.md` §7 (Cloud-hosted session).

The owner's feedback on v2: every question went orchestrator → agent → wait (wake, busy, long turn) → back, like writing letters. In v3, the voice answers status questions from a snapshot that is always fresh. Agents are only asked for actions, decisions and new work.

## 1. Status snapshot (machine → Cloud)

`services/drive/drive-briefing-snapshot.ts` builds the snapshot and `drive-briefing-sync.service.ts` pushes it. It makes no LLM calls; all text is something an agent already wrote.

| Part | From |
|---|---|
| `teams[]`: name, lead, members, counts (open / in progress / review / blocked / done in 24 h) | storage teams + items below |
| `agents[]`: state (working / idle / starting / stopped), `activity` (running work item, else ticket in progress, with `since`), `lastToOwner` (≤3, newest first) | team members, task pool, chat-v2 owner feed (`messagesToOwner`) |
| `items[]`: project tickets, plus work items not behind a ticket, in order of attention (review, blocked, in progress, open, done). Done and cancelled items appear only for 24 h. `last` = the ticket's last log line or the work item's `output.summary`, whichever is newer | `ProjectTicketService.list` per project, `TaskPoolService.getAllItems` |
| `waiting[]`: live owner items only. This is the briefing queue, so stale, expired, duplicate and already-answered cards are left out | `BriefingService.queue()` |

- **Text safety:** every text field goes through `speakable` (no URLs or markup), then `redactSecrets`, then clipping (names 60, titles 140, text 240).
- **Size:** at most 48 KB. Cloud refuses more than 64 KB. When the snapshot is too big, the trim order is: finished work, then older messages, then the least urgent items.

**Triggers.** Each of these schedules a rebuild. Events are coalesced, with at most one rebuild every 30 s:

- `ProjectTicketService.onChange`;
- event bus `event_published` (work items, cards);
- chat-v2 `chat_message` from an agent or the owner.

A 60 s check also rebuilds, unless a rebuild ran in the last 30 s. It uploads only when the snapshot changed (the build time is ignored). A full upload is sent every 5 minutes regardless.

**Cached reads.** A project's tickets are re-read only after a change event for that project, or after 5 minutes. The task pool is re-read only after an event-bus event, or after 60 s ().

**Upload.** `PUT /api/cloud/instances/:instanceId/briefing {snapshot}` with the machine's own Cloud token.

- Signed out: nothing is sent.
- `CREWLY_DRIVE_BRIEFING=0` turns the upload off.
- 404 / 400 / 503: try again in an hour.
- Other failures back off from 15 s to 10 min.

## 2. Voice reads the snapshot (Cloud)

Cloud keeps the latest snapshot per machine (`drive_briefings`).

- `POST /talk/session` returns `overview` for the opening update.
- `GET /talk/session/:id/briefing?scope=overview|team|agent|item&q=` answers the voice tools `get_overview`, `get_team`, `get_agent` and `get_item`, with no agent round trip.
- A machine that is offline, or whose snapshot is older than 15 minutes, is reported with "as of N minutes ago".
- The system instruction tells the voice to:
  - open with a 20–30 s update, one phrase per team, with what needs the owner first;
  - answer status questions from the snapshot first;
  - say "I'll ask Ella" and use `send_to` only when the snapshot has no answer.

## 3. Secretary mode

- **Dispatch:** several instructions in one go become one `send_to` per instruction, all at once (the Live client already runs function calls concurrently). The voice keeps talking with the owner.
- **Replies:** the portal batches them into one `[replies]` turn at the next turn boundary: who answered, who only acknowledged, who is still working and for how long.

## 4. Two-phase Drive replies

- **The delivered owner turn asks for:**
  1. `reply --drive <sid> --ack "<one sentence>"` within seconds;
  2. later, `reply --drive <sid> "<result>"`: the conclusion first, at most 3 sentences, 2–3 options if the owner must decide, no URLs or tables. Details go in the recap.
- **`--ack` is an interim reply** marked `ack`. Cloud records `ackedAt`, and poll reports `acked` per waiting conversation.
- **Priority:** Drive turns are owner turns (`isOwnerChatTurn`), so they go to the front of the queue. The PostToolUse hook injects them into a busy agent's turn. For a Drive message, the hook note asks for the ack now.

## 5. Keep-warm

- **What Cloud tracks:** the agents the owner named (`get_agent`, `get_item` assignee, `recall`, `send_to` target) and the team leads he talked to (`get_team`, team or channel `send_to`).
- **Telling the machine:** Cloud pushes `op:'warm'`, ids only, when a name is new and every 10 minutes while the phone polls. The machine reads `warm` and `warmUntil` (now + 20 min) from `machine/state`, then:
  - keeps them in `DriveKeepWarm` until that time, or until the session ends;
  - pre-starts any that are stopped.
- **While an agent is warm:**
  - the idle stop and slot freeing (`pickVictim`) skip it. The emergency memory-pressure stop and the reconciler's memory-pressure wake eviction still apply: pressure wins;
  - its start counts as owner-priority in `requestStart` and the restore queue, so it goes ahead of ordinary starts. It stays FIFO among priority starts.
