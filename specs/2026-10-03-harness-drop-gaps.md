# Harness drop gaps (crewly#1015)

Status: implemented (branch `fix/harness-drop-gaps-1015`).

A 7-day audit (Mac + steamfun-ops, 2026-09-26 → 10-02) found 12 places where
an owner deliverable or message was dropped by the harness. The rule every
fix follows: **a message ends either delivered, or with the owner (or, for
agent-to-agent traffic, the orchestrator) told.** Never a silent drop. Text
the harness writes is English.

Some gaps were already closed by work merged after the audit:

| # | Gap | Status |
|---|-----|--------|
| 1 | Orc answers dropped as "self-report" | fixed here (§1) |
| 2 | Failed in-process turn throws the message away | fixed here (§2) |
| 3 | Settled placeholder counts as an answer | mostly fixed by #954 (turn end keeps an owed placeholder); last hole fixed here (§3) |
| 4 | FreshTaskConversation `/clear` mid-turn | fixed here (§4) |
| 5 | Queue deleted on runtime exit | already fixed by #1014 (queue kept; drops reported) |
| 6 | Restart drain misses write paths | fixed here (§6) |
| 7 | Threaded owner message never routed or tracked | fixed here (§7) |
| 8 | DM reply lands in an old thread | fixed here (§8) |
| 9 | Decision answer to the asker never retried | fixed here (§9) |
| 10 | Promise tracker silently bulk-cancelled | cancel/expiry fixed here (§10); WorkItem→promise linking deferred |
| 11 | Orc chat channel not mirrored to Slack | fixed here (§11) |
| 12 | Backend silent for hours, no alert | local detection + owner alert here (§12); Cloud-side alert while down deferred |

## §1 The orchestrator's own answers

`POST /api/chat/agent-response` treated every post whose sender is the
orchestrator and whose `senderType` is `agent` as a self-report and dropped
it ("Orchestrator self-report acknowledged (not echoed back)"). The orc on
steamfun-ops answers with the agent `reply-chat` skill, so 8 answers to
people were lost there (a finished transcript link among them).

Now only a **status line** from the orchestrator is a self-report: content
matching `ORC_STATUS_FORWARDING.STATUS_MARKERS`, or any status-shaped
opening (`STATUS_SHAPED`: `[WAITING]`, `[PENDING]`, `[IN-PROGRESS]`, any
all-caps bracket tag — report-status takes a free-form `--status`), without
`intent: "message"`. Anything else the orchestrator posts is its message to
a person and is stored exactly like an `orchestrator` post.

## §2 Failed in-process turns

`InProcessTurnFailureService` handles a turn of the in-process Crewly Agent
runtime that throws (DeepSeek "No output generated", out of credit, a
crashed worker), from both delivery paths (`sendMessageToAgent` and the
terminal `/write` in-process branch):

1. **Not a model failure:** an agent the owner stopped, or whose runtime is
   not running, gets the message on its persistent queue for its next
   start. Nothing is retried or reported.
2. **Retry once** after `RETRY_DELAY_MS`, through `sendMessageToAgent` — not
   when the account is out of credit / quota (it fails the same way), not
   when the failed turn already answered where the message came from
   (`watchdog.answeredSince`), and never twice for the same message.
3. **Then tell, once per episode.** The owner messages the agent owes are
   parked by the watchdog (`failed_wait`): the owner is told once per
   message with the reason; the message is re-delivered after 30 min, 2 h
   and 6 h (`FAILED_RETRY_BACKOFF_MS`) and always when a turn succeeds —
   never on a timer when credit / quota is out (only a successful turn:
   credit restored, another runtime, the owner acted). The failure is
   reported once per episode — a member's to the orchestrator, the
   orchestrator's to the owner — until the agent completes a run.
4. A watchdog reminder never starts an agent the owner stopped
   (`isOwnerStopped`): the owner is told it is not running instead.

The usage-limit detection (#916) is unchanged and still runs first; the
external runtime tags the error with the limit kind it matched.

## §3 Settled placeholders

Since #954 a turn end keeps the placeholder of a message the watchdog tracks
as owed. The remaining hole: the "settled" listener told the watchdog the
whole thread was answered for **every** settle, including

- `reply --none` by an agent that is not the one responsible (the watchdog's
  own `closeByAgent` refuses that waiver, the listener bypassed it), and
- a turn-end settle of another agent's placeholder that was not owed by it.

Settle listeners now receive why (`answered` | `not-owed` |
`no-reply-needed`) and the agent. Only `answered` clears watchdog entries;
`reply --none` is handled by `closeByAgent` (responsible agent only), and
`not-owed` clears nothing.

## §4 FreshTaskConversation never clears mid-turn

The new-task `/clear` took "not `in_progress` + 8 s of PTY quiet" as idle.
A model writing a long tool input is silent: Atlas was cleared 18 s after
promising the agreement PDF. Now:

- `isBusy` asks the runtime turn state first (#1013 `AgentTurnStateService`):
  `turn` or `background` is busy whatever the screen says;
- the new-task path takes the same last look as the context-cap path right
  before Escape + `/clear` (a delivery in progress or a busy agent → no
  clear).

## §6 Restart drain covers every write path

Once a graceful shutdown pauses delivery, `queueIfRestartDraining` puts a
message on the persistent queue (flushed by the next boot's registration)
instead of writing it, on the paths that bypassed `sendMessageToAgent`:
terminal `/write` (`mode: "message"` and the in-process branch), terminal
`/deliver` (forced or not), and the session write endpoint. Raw keystrokes
(`mode` unset) still pass. A held WorkItem brief keeps its `workItemId` on
the queue; its hand-over (dispatcher dedup, fresh conversation) runs when it
is finally written.

Follow-up M1: `prepareWorkItemHandOver` reports `alreadyDispatched` when the
dispatcher's dedup key was taken (the startup backfill or the grace timer
delivered the WorkItem while its brief sat on the queue); the flush then
drops the held brief instead of delivering it twice. A thrown send gives the
key back. When a drain outlasted the grace period and both the held brief
and the dispatcher's own notice were queued, the agent is briefed once in
either order: the stale check drops a notice whose WorkItem was already
delivered to that agent (`isDelivered`), and a notice delivered from the
queue marks its WorkItems delivered, so the brief after it is dropped. Only CONFIRMED deliveries count
for `isDelivered` — a direct hand-over claim, a write straight into the
agent, or a notice delivered from its queue. A dispatcher write the terminal
answered with `202 queued` (the agent was stopped or starting) is tracked as
pending-queued: still deduped (no second push, and a redispatch writes
nothing while the notice waits on the queue), but never dropped as stale.

## §7 Owner room messages that stop half-way

"旧模板是什么" (10-02 15:50 ET, #C0C46TTBNNP) was received and recorded in
the huddle 15 s later, then nothing: no "routed", no "reached nobody", no
watchdog entry. One of the awaits after the record never settled or threw,
and every safeguard sits after them.

Now, once an owner's room message is recorded:

- every await **before** dispatch (room presence, dispatch plan, seen
  reaction, placeholders, roster, ticket intake, thread context) is bounded
  by `ROUTE_STEP_TIMEOUT_MS`; routing goes on without it;
- a route guard rescues a routing that throws, or has not reached dispatch
  within `ROUTE_STALL_MS`, with the unanswered-message fallback (the room
  lead here is handed the message, without the Slack thread context; a
  stuck hand-off tells the owner in the thread);
- dispatch itself is never timed (sequential cold starts take minutes) and a
  throw after it started is not rescued; a routing that reaches dispatch
  after a rescue ran stops there — no second delivery, no second watch.

Follow-up L2: on a rescue the placeholders the stuck routing posted are
withdrawn quietly (`SlackTypingPlaceholderService.withdraw`: no answered /
settled listeners, no ✅) before the hand-off posts its own, and the stuck
routing posts no more. A ticket intake that finishes only after the message
went out without its marker is linked to the delivered copy
(`intakeWithin` `onLate` → `linkLateTicket`).

## §8 DM replies and old threads

An unattributed DM answer went to the OLDEST open thread, even one opened
18 h earlier. Order of choice now: named key → thread root → attachment
after a reply → the thread the agent's current turn came from
(`turn-origin`; the origin lasts the whole turn, not only its first 15 min)
→ the oldest open thread opened within
`SLACK_AGENT_DM_CONSTANTS.OPEN_THREAD_MAX_AGE_MS` → the thread the owner
wrote in last.

Follow-up L3: "still in the turn" is read from
`InFlightTurnTracker.hasOpenTurn` and the runtime turn state — read only, no
`settle()` probe.

## §9 Decision answers the asker could not take

When the asking agent cannot be reached, the answer goes on the persistent
queue (delivered when the agent is next idle or registers; a drop is
reported by the queue's drop listener) instead of only a log line.

## §10 Promises closed undelivered

A commitment closed silently when someone cancelled its follow-up WorkItem
(Sam's cleanup cancelled ~60 tracked promises, Owen's CE-16/CE-36 links
among them), or when it expired after 7 days. Now:

- the cancel API (`POST /task-pool/items/:id/cancel`) records the cancelling
  agent session on `metadata.cancelledBy`;
- a commitment whose follow-up was cancelled by **another** agent, or that
  expires without the owner ever being told it was late, is told to the
  owner once, in one note per request: "<Name>'s promise "<text>" was
  closed without being delivered: <who> cancelled its follow-up ("<reason>")
  / nothing happened on it for 7 days. If you still want it, ask <Name>
  again."

The promising agent cancelling its own follow-up, the orchestrator (it
cancels on the owner's word), an unknown canceller,
owner skips, superseded promises and cancelled tickets stay quiet: those
were closed on purpose.

Deferred: linking a finished WorkItem that is not a child of the request
(Owen's CE-16/CE-36 project tickets) to the promise it fulfils needs a
matching design (promise text ↔ ticket) and is not in this change.

## §11 The orchestrator's own chat and the away owner

The orchestrator's chat-v2 DM (the dashboard "Orchestrator" chat) has no
Slack link. An orchestrator answer there is also DMed to the owner by this
machine's orchestrator bot, only when all hold:

- it is a real answer: not an interim note, not a bare acknowledgement, and
  the orchestrator's current turn is the owner's message in that chat (never
  a reply to a system event — proactive follow-ups are not mirrored);
- the conversation does not already reach the owner: not a Slack thread, a
  Slack-linked DM, a mapped room, or a Telegram / Google Chat / WhatsApp
  thread;
- the owner has not written in that chat outside Slack in the last
  `DM_AFFINITY_FRESH_MS`;
- the same text in the same conversation goes once (24 h); at most one DM
  per conversation per 10 min, later answers batched into the next.

The DM keeps the orc's Slack mrkdwn (links intact), and the
owner-notification fallback carries a generic title.

Follow-up H1 (as re-reviewed): a **system-event turn** is mirrored only
when the event belongs to that chat — it names a WorkItem, ticket or request
whose origin chat (`Request.chatRef`) is that conversation (a delegated
result, a promise follow-up such as 「登上了吗？」) — and the owner wrote there
within `SYSTEM_TURN_OWNER_WINDOW_MS` (24 h), at most
`SYSTEM_TURN_DAILY_CAP` (3) per chat per 24 h. Digests, an agent [DONE] for
unrelated work and reminders name no such item and send nothing. An answer
to the owner in another conversation is not mirrored. Dedupe and batching
are unchanged.

## §12 Liveness

`LivenessMonitorService` writes `<CREWLY_HOME>/liveness.json`
(`lastAliveAt`, `pid`, `cleanShutdownAt`, `crash`) every `TICK_MS` and
detects:

- **stall**: two ticks more than `GAP_ALERT_MS` apart on the monotonic
  clock (event loop blocked, process stopped). A gap only the wall clock
  shows is the computer sleeping (macOS's monotonic clock does not advance
  in sleep): logged, no DM;
- **crash**: the uncaughtException / unhandledRejection handlers record a
  crash instead of a clean shutdown; the next boot tells the owner however
  fast it came back;
- **unclean stop**: at boot, the previous process's last tick is more than
  `GAP_ALERT_MS` old and it recorded no clean shutdown.

Each is logged as an error and the owner is told once by Slack DM, retried
each tick until Slack is up (for at most `ALERT_RETRY_MAX_MS`).

Deferred: an alert **while** the machine is down has to come from Cloud
(heartbeats stop → `instance_stale` → owner DM), in crewly-services.

Follow-up M2: crashes not yet told are carried in `liveness.json`
(`crashAlert`). At most one crash DM goes out per `CRASH_MERGE_WINDOW_MS`
(1 h); crashes in between are merged into the next DM with a count
("crashed 3 times between … (last: …)").
