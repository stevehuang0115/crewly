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

**Cached reads.** A project's tickets are re-read only after a change event for that project, or after 5 minutes. The task pool is re-read only after an event-bus event, or after 60 s (`SnapshotSourceCache`).

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

## 6. Briefing quality (2026-10-10)

Owner feedback: items the owner asked for were read out as if the team asked; finished and shipped items still showed as open; the briefing read cached state.

- **Direction.** A finished ticket is the team reporting back on something the owner asked for. `reviewSummary` says "You asked Pia: <ask>. Pia reports: <answer>. Accept it or send it back?" (the ask comes from the description, the category tag and attachments are stripped; the result is the first sentences of the agent's answer). A collapsed entry reads "Milo reports back on 3 things you asked for: A, B, C".
- **No review for conversation.** `triageReview` (`briefing-review.ts`) leaves a finished ticket out when the owner's message was a question or a status check ("did you get it?", "where is the draft?"), a long reflective voice note with no request, a `question` ticket, or when it has sat in review longer than 3 days. Those were answered in the conversation; there is nothing to accept. Real deliverables stay. Deterministic, text only.
- **Freshness.** A decision card whose project ticket is already done or cancelled is left out (`isCardTicketClosed`). The existing rules (deadline, age, answered in thread, duplicates) still apply.
- **Check with the teams.** Drive's opening turn says it is checking, then calls `get_overview` with `fresh=true`. Cloud pushes `op:'refresh'` (with an id) to each live machine and waits up to 25 s for its fresh snapshot. On `refresh` the machine (`DriveStatusCheck`):
  1. finds the running agents that hold the owner's open items (cards, questions, finished work), at most 6, busiest first; stopped agents are not woken;
  2. sends each a note: close what is done or shipped, leave a one-line current status on what is open, do not message the owner;
  3. waits 12 s;
  4. drops the snapshot caches and uploads a fresh snapshot.
  A machine that does not answer in time is reported as `checked.timedOut` and read as "as of N minutes ago".

## 7. Greet first (2026-10-11)

Owner feedback: on start the voice "thought" for up to 25 s (the `fresh=true` check with the teams) before saying anything.

- **The first utterance never waits on a tool call.** The kickoff turn asks for a greeting by name ("Hi Steve, …") and the choice: check in with all the teams, or something specific (the big picture of who is working on what is offered too). The voice instruction says the same (`Opening — greet FIRST`).
- **The check with the teams runs in the background from the moment the session opens.** Cloud stores it in the session (`freshCheck`: running / done, machines asked, refreshed, timed out), so any auth node can wait on it. It pushes `op:'refresh'` to each live machine as before.
- **`get_overview` no longer takes `fresh`.** It waits at most 10 s for a check still running, then says so (`checked.pending`: "one team is still reporting back"). A slow machine is `checked.timedOut`, read as "as of N minutes ago". Older clients can still send `fresh=1`: that waits for the whole check.
- **Opening hold.** Until the owner speaks (or 45 s), Cloud hands no reply to the voice, so a reply never lands on top of the greeting.

## 8. Turn state machine: topics and delivery (crewly-services `drive-flow.ts`)

Cloud decides what the voice says next; the portal asks at each turn boundary (`POST /talk/session/:id/flow {event:'next'}`) and reports how the turn ended (`settle`). Pure functions over the session's `inbox` + `flow`; tested without I/O.

**Topic discipline.** The owner's topic is the team or agent he last talked to (`send_to`, `ask_team`, `get_team`, `get_agent`, `recall`; replying to a delivered answer makes it his topic too). A reply of another topic is held, never injected mid-conversation:

1. Held replies are marked (`heldAt`). At the next boundary the voice wraps up: "Is that all good for CE? Anything else on it?" (`wrap_up`; it does not mention the held reply).
2. The owner says that is all (the voice calls `topic_done`), or is silent for 40 s, or the topic idles out (90 s): the voice offers: "Marketing also just replied — want to hear it now, or move on?" (`offer`; who, not what).
3. Yes: `check_replies` hands them over. Not now: `hold_replies` parks them for the next session.

The pending queue is ordered by priority (asks the owner > answer > update), then arrival. Acknowledgements and updates ride along with their conversation's answer and are dropped once it is in. A delivery alone does not make a topic (until the owner reacts, the queue reads on).

**Delivery tracking, per reply:** `queued -> speaking -> heard`. `heard` only when the portal reports the turn was spoken to the end. A cut-off turn (interrupted, socket closed, page hidden, call), or one never settled (75 s), puts the reply back to `queued` with `redelivery`; three tries park it (`deferredAt`). `resume` (after a reconnect) recovers everything in flight and tells the voice where we were.

**Next sessions.** Replies never heard stay in their session (kept 7 days instead of 1) and carry over: a new session copies them into its inbox, held, so they are offered, not read over the greeting. `GET /talk/session/missed` lists them (the portal start screen shows the count).

**Wire:** `POST /:id/flow {event: next|settle|read|topic_done|hold|activity|resume, turnId?, heard?}`; the poll carries `flow: {topic, held, unheard}`.

## 9. High-level overview (`get_org_overview`)

For an owner who keeps the whole organisation in his head. Built with no LLM:

- **Machine** (`drive-org-overview.ts`): per team, from the team roster (#1221: charter, paused, chore-free finished and open work), the snapshot's counts and items, and the waiting items: purpose, members, state (`needs_you` / `blocked` / `active` / `quiet` / `paused`), finished in 24 h (2 titles), in progress (2 titles), blocked, waiting on the owner, last activity; plus agent counts. Part of the snapshot (`org`); trimmed before items when the snapshot is too big.
- **Cloud** (`drive-org.ts`): merges machines (an older machine's `org` is derived from its teams and items), returns totals, the top 5 active teams with one line each, in progress, blocked, waiting on the owner, the quiet teams ("and 5 more teams were quiet"), and a ready-made `summary` of about 25 seconds.
- Offered as the first option in the greeting.

## 10. Session log

Every session leaves a record, kept on Cloud for 30 days (`drive_logs`) and copied to the owner's machine for a local Claude Code:

- **Content:** timestamped transcript (owner and assistant turns, as transcribed), tool calls in brief, replies presented (ids) and their outcome (`heard` / `acked` / `decided` / `deferred` / `skipped` / `not_delivered`), decisions, reconnects, errors, and hiccups (`owner_confused`: "what is this about?" within 90 s of a presented reply; `repeated_item`; `cut_off`). Secrets are masked; text is clipped.
- **Written by:** Cloud for what it runs (start, send/ask, recall, status, flow outcomes, end) and the portal for the rest (transcript, waiting-item tool calls, decisions, reconnects) through `POST /:id/log` in small batches.
- **On the machine:** `op:'log'` (sent at the end of a session, and at the next start for a session that was never ended) makes each live machine fetch `GET /:id/machine/log` and write `~/.crewly/drive-logs/<YYYY-MM-DD>-<sessionId>.md` and `.jsonl` (kept 30 days, pruned on write; names validated).
- **Reading:** `GET /api/drive-logs?limit=` and `GET /api/drive-logs/:id?format=md|jsonl` (OSS), the `drive-logs` orchestrator skill, or the files directly.

## 11. The next session knows the last one; decisions are not asked twice

- **Summary at start.** The start returns a compact summary of the previous two sessions (topics, decisions, deferred, not delivered). The kickoff gives it to the voice: do not repeat what was decided or heard; pick up what was deferred or not delivered.
- **A decision is written where the team looks, at once.** The voice decides a waiting item with `answer_item` (never `send_to`): the decision card is answered, the ticket review accepted or sent back, the owner's words posted to the agent, and now a decision card tied to a project ticket also gets a ticket log line ("Owner decided in Drive: …", `BriefingDeps.noteDecision`).
- **And suppressed in the briefing before the team acts.** The portal logs a `decision` event with the item's reference (`D-7` / `TKT-5` / `Q-…`). Until a status snapshot no longer holds the item, Cloud leaves it out of every briefing view (`alreadyDecided` lists them, "say only if asked"; `get_item` answers "you decided X on <date>, waiting for the team").
- **Measured.** The first snapshot of the machine that holds the item (by agent name) which no longer lists it stamps `team_acted` in the log with the delay (`latencyMs`). The log's Decisions section shows "team acted after N s" or "team has not updated it yet".

## 12. Reconnect, outages, and not repeating

Transport: a WebSocket to Gemini Live (not WebRTC; there is no ICE state). Detected losses: socket close; `offline` / `online`; the voice owing an answer and silent for 20 s (watchdog); audio taken by the system (AudioContext `interrupted` / `suspended`, mic track ended or muted: an incoming call, another app); page hidden / `pagehide` (turn cut off at once) and `pageshow` / `visibilitychange` (connection replaced if away for 4 s or more).

- **Shown at once:** "Connection lost — reconnecting…" (with a short lower tone, a higher one when it is back).
- **Generate nothing while disconnected.** No turn is sent without a ready session; the turn in flight is reported cut off (Cloud queues the reply again); a decision that arrives after the moment passed is given back.
- **Reconnect** with backoff 1, 2, 4, 8, 15 s, then every 15 s until 5 minutes after the drop; on return to the foreground or `online` it tries at once with a fresh budget.
- **Audio the browser will not restart** (iOS after a call) shows one big Resume button and says why; the tap restarts audio and reconnects.
- **Exactly one resume per recovery.** One turn on the live socket: "Sorry, we got cut off. We were on <topic>; I'd just said <short recap> — shall I continue?"; then it continues from the first thing the owner has not acknowledged. The reply that was being spoken is delivered again by Cloud (once, flagged "as I was saying"); a reply is spoken at most once per successful delivery (claimed by turn id on Cloud). Tested: an outage during the summary gives exactly one resume and no repeats.

## 13. Persona, and facts only

- **Persona.** The voice is Crewly, the owner's executive secretary and chief of staff: capable, warm, with personality, natural phrasing and brief acknowledgements, remembers the session, proactive in one short sentence. No invented human name (the product voice card already says "Crewly"). It replies in the language the owner just spoke (Chinese or English).
- **Facts only; ask the team.** The voice answers only from facts it has (ticket text, agent reports, the status). When the owner wants more detail than those facts give, or asks the same follow-up a second time, it says "I'm not sure — let me ask <who>" and calls `ask_team(target, question)`: the owner's words go verbatim to the owning agent over the Drive channel (with the Drive session id, as any Drive message), the call is logged as `ask_team`, and the answer comes back as a normal queued item framed "<agent> answered your question about "<question>": …", under the topic rules above.

## 14. Meetings P2b: a 1:1 meeting with an agent (crewly#1415)

The owner can hold a voice meeting with one agent. Cloud runs it and the voice speaks as that agent. This machine answers for that agent only. The code is in `services/drive/drive-meeting.service.ts`, `drive-meeting-pack.ts` and `drive-meeting.wiring.ts`. The constants are in `MEETING_CONSTANTS`.

- **Capability.** When the Drive handler runs with a meeting service, it advertises `meeting_pack`. Cloud asks for a pack only from machines that advertise it.
- **Pack (`op:'meeting_pack'`).** The machine reads `GET machine/packs/:id` → `{agentSession, name, role?, team?, language}`, builds the pack and posts `{instanceId, pack}` back. The pack holds:
  - the agent's name, role and team;
  - its newest handover, clipped to 12k characters;
  - its work and waiting items from the status snapshot;
  - the last 20 owner↔agent messages, from DMs and threads (14 days);
  - its decisions settled in the last 30 days;
  - the agenda;
  - up to 10 wiki pages, found by BM25 over the team name, the role and the agenda topics.
- **Clean text.** Every text field is made speakable. Harness tags (`[SLACK-THREAD:…]`, `[Drive mode …]`) are removed, secrets are masked and long text is clipped.
- **Size.** The pack is kept under about 15k tokens, since it sits in the Live system instruction and is billed on every turn. To fit, the machine drops wiki pages first, then the oldest messages, then cuts the handover.
- **Agenda.** At most 15 topics `{threadRef, topic, state, lastAt, where, recent}`:
  - `waiting_on_owner`: an open decision card of this agent. The topic's thread is the card's Slack thread.
  - `question`: the agent's last message in the thread asks the owner something.
  - `in_progress`: the owner wrote last, so the agent owes the answer, or the agent said it is on it.
  - A settled thread is left out. A room thread is on the agenda only when the owner and this agent both spoke in it.
  - Thread refs are `slack:<conversation>:<thread ts>` for Slack threads (DM or room). Crewly chat threads are `chat:<channel>:<root message id>`. A DM without threads is `chat:<dm channel>`.
- **Privacy.** The pack and the wiki search use only this agent's own data:
  - its timeline, its cards and its snapshot rows;
  - its teams' vaults (`CREWLY_HOME/teams/<teamId>/wiki`) and those teams' project vaults;
  - never the global wiki or another team's vault. Page visibility follows the agent's role.
- **Live wiki search (`op:'wiki_search'`).** The machine reads `GET machine/wiki/:id` → `{agentSession, query}`, runs BM25 over the agent's vaults and posts back `{instanceId, hits[≤5 {title, where, text≤700}], ms}`. Measured locally: about 40–90 ms over one team's vaults, and 200–400 ms when a large project vault is included. The relay round trip comes on top of that.
- **Write-back (a delivery carrying `writeBack {kind, topic, threadRef?|newTopic}`).** No Drive conversation is opened. The text is `From our voice meeting — <Decision|Answer|New task|Note>: <the owner's words>`, and it goes:
  - to a Slack thread: the agent's own bot posts it in the thread (DM or room). The post is recorded in the Crewly chat channel that mirrors that Slack conversation (rooms: under the thread root). The row is an owner turn (`source: 'cloud-talk', via: 'meeting', slackAlreadyPosted`) and is dispatched to the agent like any owner message.
  - to a decision card's thread: a `decision` / `answer` first tries to settle the card with the owner's words (`answerInWords(…, 'voice')`). When the words settle nothing, it is posted in the thread as above.
  - to a Crewly chat thread: it is recorded in that thread and dispatched.
  - for a new topic: a new top-level message in the agent's Slack DM when its bot is installed, or else a new root in the owner's Crewly chat DM with the agent. The new thread is remembered per session and topic, so the next write-back on that topic goes into the same thread.

  The machine then posts `POST machine/deliveries/:id/written {instanceId, threadRef}`, and Cloud records the thread in the meeting's decisions and to-dos.
