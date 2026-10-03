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

Now only a **status line** from the orchestrator (content matching
`ORC_STATUS_FORWARDING.STATUS_MARKERS`, without `intent: "message"`) is a
self-report. Anything else the orchestrator posts is its message to a
person and is stored exactly like an `orchestrator` post (same conversation
routing, same Slack mirror). The 2026-09-13 loop fix is unaffected: the
orc's `report-status [DONE]` still never comes back to it.

## §2 Failed in-process turns

`InProcessTurnFailureService` handles a turn of the in-process Crewly Agent
runtime that throws (DeepSeek "No output generated", out of credit, a
crashed worker), from both delivery paths (`sendMessageToAgent` and the
terminal `/write` in-process branch):

1. **Retry once.** The same message is delivered again after
   `IN_PROCESS_TURN_FAILURE_CONSTANTS.RETRY_DELAY_MS` through
   `sendMessageToAgent`, so a runtime switch, the token cap or the restart
   drain can queue it instead.
2. **Then tell.** When the retry fails too (or cannot be made):
   - owner messages the agent owes are noted at once in their thread with
     the real reason (watchdog `noteTurnFailed`), and **kept**: the entry is
     parked (`failed_wait`) and re-delivered every
     `OWNER_MESSAGE_WATCHDOG_CONSTANTS.FAILED_RETRY_MS` and when the agent's
     next turn succeeds, until `LOGIN_WAIT_DROP_MS`. One note per message,
     not one per failure.
   - the failure itself is reported: for a member, to the orchestrator; for
     the orchestrator, to the owner's Slack DM. At most one report per agent
     per `NOTICE_COOLDOWN_MS`; the next one says how many turns failed in
     between, so 80 failures are a handful of notices, not 80.

The usage-limit detection (#916) is unchanged and still runs first; a
recognised limit moves the agent to its fallback, and the retry is then
queued for the new runtime.

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
(`mode` unset) still pass: they are how the owner manages a session.

## §7 Owner room messages that stop half-way

"旧模板是什么" (10-02 15:50 ET, #C0C46TTBNNP) was received and recorded in
the huddle 15 s later, then nothing: no "routed", no "reached nobody", no
watchdog entry. One of the awaits after the record (room presence, ticket
intake, thread context, dispatch) never settled or threw, and every
safeguard sits after them.

Now, once an owner's room message is recorded, a route guard is armed:

- routing that throws → the rescue runs, then the error propagates as
  before;
- routing still unfinished after `SLACK_TEAM_CHANNEL_CONSTANTS.ROUTE_STALL_MS`
  → logged as an error and the rescue runs.

The rescue is the existing unanswered-message fallback, run at once: the
room lead here is handed the message; if that hand-off itself stalls or
fails (or the message already was a hand-off), the owner is told in the
thread. Late completion of the original routing settles nothing twice.

## §8 DM replies and old threads

An unattributed DM answer went to the OLDEST open thread, even one opened
18 h earlier, so an answer to a new question landed under an old one. Open
threads older than `SLACK_AGENT_DM_CONSTANTS.OPEN_THREAD_MAX_AGE_MS` no
longer attract answers. Order of choice: named key → thread root →
attachment after a reply → oldest open thread that is still recent → the
thread the agent's current turn came from (`turn-origin`) → the thread the
owner wrote in last.

## §9 Decision answers the asker could not take

When the asking agent cannot be reached, the answer goes on the persistent
queue (delivered when the agent is next idle or registers; a drop is
reported by the queue's drop listener) instead of only a log line.

## §10 Promises closed undelivered

A commitment closes silently when someone (an agent cleaning up, a bulk
script) cancels its follow-up WorkItem, or when it expires after 7 days.
Both now tell the owner once in the request's thread, in one note per
request: "<Name>'s promise "<text>" was closed without being delivered
(<why>)." Owner skips, superseded promises and cancelled tickets stay
quiet: the owner or the agent closed those on purpose.

Deferred: linking a finished WorkItem that is not a child of the request
(Owen's CE-16/CE-36 project tickets) to the promise it fulfils needs a
matching design (promise text ↔ ticket) and is not in this change.

## §11 The orchestrator's own chat and the away owner

The orchestrator's chat-v2 DM (the dashboard "Orchestrator" chat, e.g.
`a721f48d`) has no Slack link, so the orc's proactive follow-ups posted there
("…登上了吗？") never reached an owner who uses Slack. An orchestrator post
into a conversation that is not a Slack thread, a Slack-linked DM or a
Slack-mapped room is now also DMed to the owner by this machine's
orchestrator bot (`SlackReloginDmService.sendToOwner`) — unless the owner
wrote in that chat from the dashboard within
`REPLY_ROUTING_CONSTANTS.DM_AFFINITY_FRESH_MS` (they are looking at it).

## §12 Liveness

`LivenessMonitorService` writes `<CREWLY_HOME>/liveness.json`
(`lastAliveAt`, `pid`, `cleanShutdownAt`) every `TICK_MS` and detects:

- **stall**: two ticks more than `GAP_ALERT_MS` apart (machine asleep, event
  loop blocked, process stopped);
- **unclean stop**: at boot, the previous process's last tick is more than
  `GAP_ALERT_MS` old and it recorded no clean shutdown.

Either is logged as an error and the owner is told once by Slack DM
("Crewly on <machine> was not running from <start> to <end> (<duration>)…"),
retried each tick until Slack is up (for at most `ALERT_RETRY_MAX_MS`).

Deferred: an alert **while** the machine is down has to come from Cloud
(heartbeats stop → `instance_stale` → owner DM). That lives in
crewly-services.
