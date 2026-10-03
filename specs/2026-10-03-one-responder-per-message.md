# One responder per owner message in Slack rooms

Owner's rule, 2026-10-03. When someone speaks, only the person whose job is closest to it replies. Everyone else listens and takes in the context.

## Incident

2026-10-03, the Mac, private channel #content-team (`C0C46TTBNNP`).

1. Atlas (Think Tank) posted a reminder about decision card D-92 in a thread.
2. The owner replied in that thread without an @: 「我之前不是说了吗 两者应该都要有」.
3. At 16:41:17Z two things happened at once:
   - `[DecisionCards] Owner decision resolved D-92 via reply`: the decision path delivered the answer to the asker (Atlas).
   - The same message was also routed as `strategy: huddle-broadcast, threaded: true` to the room's agents.
4. Atlas answered at 16:41:28. Ella (Crewly Marketing) posted almost the same answer about 6 minutes later.

There were two root causes:

- The decision path and the room path each acted on the message without knowing about the other.
- The room path itself allows several answerers. In a thread, every engaged agent hears a bare follow-up: the last speaker as `required`, the rest as `optional`, and an optional agent may still decide to answer. At top level with no @, every awake agent hears it as `optional`.

## Rule

### 1. Exactly one responder per inbound owner message

The harness chooses the responder. Check these in order:

| # | When | Responder |
|---|---|---|
| a | The message answers an open decision card in this thread | The card's **asker** |
| b | The message @'s agents explicitly (`<@U…>`, `@Name`, a leading name, Cloud's `mentionedAgentSessions`, a hand-off) | The @'d agent(s) |
| c | Thread reply, no @ | The **thread owner**, read from the Slack thread (see below) |
| d | Top level, no @ | One agent chosen by the existing room rules (below) |

About (a) and (b): an explicit @ always wins. This is the owner's standing Slack rule ("a channel @ goes only to that agent"). If a reply in a card's thread also @'s another agent, that agent answers. The asker still gets the decision through the decision path (§3). Several explicit @'s mean the owner asked several agents, so each of them answers. That is the only case with more than one responder.

**Thread owner (c).** This is computed from the Slack thread itself (`conversations.replies`, already fetched as `message.threadContext`). Every machine reads the same thread, so every machine picks the same owner:

1. **A decision card or card reminder** that an agent posted after a person last spoke in the thread. The owner's message is then the first reply to that card, so it answers the card. This is the same thing the decision path decides on the asker's machine, but read from Slack so every machine agrees. Card text is recognised by `Decision D-n`, `[D-n]`, or `Still waiting on you`. `cardFallbackText` now always carries the decision id.
2. Otherwise **the agent that spoke last** in the thread. This is the owner's 2026-09-21 rule: a bare follow-up addresses whoever just spoke. Probe: Atlas starts the thread, the owner says "looks off", Ella says "I can dig into it", the owner says "yes please do". Ella is the responder.

An earlier draft preferred the agent that started the thread and matched @'s by rendered display name to tell whether "the conversation moved on". Review dropped it: it picked Atlas in the probe above, and display-name matching of @'s is unreliable. There is no starter rule and no @-by-name matching any more.

How a post's author is mapped to an agent:

- A post whose `user` is a local agent's own bot user id is that local agent.
- Any other bot post is matched by display name against the room's members on other machines (Cloud's `room.members`). Local agents posting with a username override are matched by name against the local roster.
- A name that matches more than one agent counts as unclear and is skipped.

**Liveness.** A thread owner on another machine is pinned only while Cloud's room snapshot shows it awake. An offline, stale or retired machine must never be the only answerer. Every machine judges by the same snapshot, its own agents included. A card's asker is the exception: its own machine's decision path takes the reply.

If the owner is not live, the room's own rules apply, and only on the #1019 room owner machine (`roomOwnerInstance`, else Cloud's `room.fallback` machine). Every other machine defers.

**Unreadable thread.** The Slack thread may be unreadable on a machine (no scope, rate limit, or more than 3 s).

1. The machine retries the read once, after a short pause (`THREAD_READ_RETRY_BACKOFF_MS`, `readThreadContext`). If Slack rate-limited every token, the retry waits out the shortest retry-after, as long as the whole retry stays within `THREAD_READ_RETRY_MAX_WAIT_MS` (2 s). If the retry-after is longer, the retry gives up at once.
2. If the read still fails, a machine that is not the room's watcher defers, and every local member gets context only.
3. The watcher machine answers from its own chat log only when that log can be trusted to name the last speaker. Cloud never forwards other machines' bot posts, so with colleagues on other machines in the room, the log is trusted only when both of these hold:
   - its latest agent turn in the thread is local and less than `LOCAL_LOG_FRESH_MS` (10 min) old;
   - no person has since @'d an agent on another machine (`slackMentionedAgents`). That agent's answer, with no @ of anyone here, would never reach this log. For example: local Atlas answers, the owner writes "@Ella …" (remote), Ella answers on her machine, and the owner writes "ok go ahead". The log must not pick Atlas.

   A room whose members all run on this machine always trusts its log.
4. Otherwise (latest agent speaker remote, no agent turn, or a stale log), the watcher machine answers nothing and keeps the 90 s watch only. The fallback reads Slack again before it hands anything over.

Without Cloud presence (one machine), local rules apply.

**The watcher machine** (`roomWatcherInstance`) is the #1019 room owner. If there is none, it is Cloud's `room.fallback` machine. If nobody is awake and no fallback machine is named, it is the lowest instance id among the machines Cloud reports live (a member's `live`, when Cloud sends it; a machine marked `live: false` never counts). Every machine computes the same machine from the same snapshot.

**Note-only watches.** Two kinds of machine keep a *note-only* watch:
- in the last-resort case, every other machine that received the message, because the chosen machine may be gone (today's Cloud sends no per-machine liveness);
- a machine that cannot resolve its own instance id.

A note-only watch waits `NOTE_ONLY_WATCH_MS` (120 s) and then tells the owner ("nobody could take this") only if Slack shows no bot post after the message. It never hands the message to anyone, so two machines never both hand it off.

**When the fallback cannot re-read Slack** at 90 s, it posts the "nobody could take this" note instead of handing the message off blind. Rescues of a stalled routing (#1025) still hand off.

**Decision asker not in the room.** If the card is still open and its asker is not in this room, there is no pin. The message falls through to (c) and (d).

**Top level (d).** This keeps the #1019 single-machine owner. Only the machine `roomOwnerInstance` names takes an un-@'d message, as before. Among the agents awake on that machine, it picks **one**:

1. the team leader, if awake;
2. else the awake agent that spoke last in the room;
3. else the first awake agent by session name.

The pick stays `optional`, matching the owner's rule "with no @, only the TL is optional". It may decide the message is not for the agents, or @ a sleeping colleague who should answer. When nobody is awake anywhere, the existing wake-up rules apply unchanged: Cloud's fallback machine wakes the TL or the private room's orchestrator.

### Everyone else: context only

Every other local room member gets the message as **context only**. It is not delivered now and nobody is woken for it. Instead it is queued per (agent, room) and put at the top of that agent's next prompt from the same room:

```
[Context only — not for you to answer] Messages in this room since your last turn:
  - owner (thread 1738.1): 我之前不是说了吗 两者应该都要有 — Atlas is answering this; do not reply unless you are asked.
```

This costs no extra turn, no cold start and no 👀. The queue is in memory and bounded: at most `ROOM_CONTEXT_CONSTANTS.MAX_ENTRIES` entries per (agent, room), each clipped to `PER_ENTRY_CHARS`, and dropped after `TTL_MS`. A restart loses it. That is acceptable, because the Slack thread context still shows the thread when the agent is next addressed there.

### Restarts

**A restart loses the context queue. That is accepted.** The queue holds context, not work. Nobody is waiting on it, and the Slack thread context still shows the thread the next time the agent is addressed there.

A restart can never leave a message without a responder. The responder is chosen fresh each time a message is routed, from durable or shared data only: the decision store, the Slack thread, Cloud's room presence, and the chat log. It never comes from in-memory state.

- **Decision memo.** It is in memory. After a restart, the router runs the decision path itself. A card that is already resolved yields "no open card", and rule (c) then picks the card's poster from the Slack thread. The asker therefore still answers, as `required`.
- **The responder step itself** is bounded by #1025's `ROUTE_STEP_TIMEOUT_MS`. If it times out or throws, the router falls back to an empty pin. The dispatcher's own rules then pick one responder: the last speaker in the thread, else rule (d). It never falls back to "nobody".
- **A local responder that cannot take the message**, for example because it is down after a restart, leaves the message undelivered. The unanswered watch is then armed as before. #1025's route guard also rescues a routing that stalls.
- **There are only three "nobody here" outcomes, and each still has a watcher:**
  - a message the decision path consumed: the asker answers, and #1025 holds its note on the persistent queue if the asker is down;
  - a live responder on another machine: the room owner machine watches;
  - a deferral to the room owner machine: that machine answers and watches.

This applies to messages written by people. Agent-authored messages (a colleague's post that @'s someone) keep their existing routing.

### 2. Reply gate (backstop)

Each owner row records whom the harness chose to answer it (`metadata.roomResponders`). A post is **held** only when all of these hold:

- the owner's latest message in the thread has recorded responders, and the agent posting is neither one of them nor @'d in that message;
- the agent owes no earlier owner message in the thread, meaning it was not chosen for, or @'d in, an earlier one it has not answered yet;
- one of the chosen responders has already answered (interim notes don't count), and that answer does not @ the agent posting.

These are review probes that must post: "@Atlas @Ella both give me your view" (Ella is posting after Atlas); Atlas writing "@Ella can you confirm?"; and an agent answering an earlier question it was given. When a post is held, the agent gets this, and is never told to drop the post:

```
Held, not posted: Atlas, the agent answering the owner's latest message in this thread, already replied: "…". Post with --adds-new if you have something new, or if you were asked.
```

- `reply-channel` returns `409` with `code: already_answered`. `reply` (the `/chat/reply` resolver path) returns the same text as its error.
- `--adds-new` (`addsNew: true`) posts anyway. A genuine new answer is never lost.
- Interim notes (`--interim`) and `--working` are never held.
- The check runs over this machine's huddle thread: local agents' answers and the colleague posts recorded here. It is one SQLite read of the thread and needs no Slack call.
- The gate only runs when the thread is known: `reply-channel --thread`, or a `reply` the resolver places in a thread. A `reply` whose destination names no thread is not gated. The one-responder routing is the main guard; this is the backstop.
- Answers by agents on other machines that were never recorded here are not seen. Cloud drops own-bot events.

### 3. Decision-resolved messages

The decision path consumes them.

- `DecisionService.handleThreadReply` is memoised per Slack message (`channel:ts`). The decision listener and the room router share one run, whichever calls first.
- When the run handled the message (resolved, skipped, snoozed, or answered by a file), the asker already has the answer through `notifyAsker`. The room delivers it to **nobody** as a task. Every local room member gets it as context only, with "<asker> is answering this".
- When the card is still there but the message did not settle it (for example "not one of the options" on a system card), the asker is the responder (a). The room delivers it to the asker as `required`.
- **Nothing the owner wrote is lost.** A reply that picks an option in more words than the option ("go with Hold") keeps the whole message (`ownerWords`), and the asker is told: `The owner's full message: "…" — do anything it asks beyond the choice, and answer any question in it.` A reply with anything beyond an option is already a word answer. Its note now says that any instruction or question in it is a task from the owner too, to be done and answered in the card's thread.
- The router waits for the decision outcome for at most `DECISION_WAIT_MS`. If that runs out, it falls through to (c). The card poster is then usually the thread owner anyway.

### 4. Across machines

- The decision card lives on the asker's machine. There, (a) applies. Every other machine sees the card post (by the asker's bot) in the Slack thread, so (c) names the same agent. Its local agents get context only.
- For a thread reply, only the machine whose agent is the responder delivers it. The responder is computed the same way everywhere: from the Slack thread and Cloud's snapshot.
- **Never without a watcher.** When the responder runs on another machine, the watcher machine still arms the 90 s watch for it (`pinned.watchHere`). There is one exception: a **card whose asker Cloud shows awake**. Its machine answers through the decision path, which posts nothing in the thread and shows no placeholder, so a watch here would hand the message to this machine's lead at 90 s and answer it twice (the D-92 pattern). The watch is armed only when that asker is not awake. The machine that defers because it cannot read the thread, or because the owner is not live, arms nothing: the room owner machine answers and watches.
- For top level, the #1019 owner machine decides, unchanged.

### 90 s unanswered fallback

The fallback still runs when the chosen responder does not answer:

- An `optional` responder at top level now arms the 90 s watch on the owning machine, in any room, not only shared ones. The other awake agents no longer hear the message, so they are no longer the backup. If nobody answers, `runUnansweredFallback` wakes the local room lead and hands the message over. If the lead was the responder, the owner-message watchdog nudges it instead.
- A `required` responder is tracked by the owner-message watchdog, as @'d agents always were.
- **A slow responder is not overtaken.** At 90 s there are two cases with no hand-off: the chosen responder holds the message on its queue (it was busy, `[AGENT_BUSY]` hold, recorded as `queued` on the dispatch outcome), or the Slack thread, read fresh, shows any bot post after the message (a reply or "X is working on it…", from any machine). The owner-message watchdog nudges instead.
- A message the decision path consumed arms nothing. The decision closes its watchdog.
- When a machine has no responder and nothing dispatched, the existing rule is unchanged.

## Not changed

- A DM wakes the agent, and it replies.
- An @'d agent must answer, in the thread.
- Thread follow-ups need no @.
- Messages addressed to people, or to agents on other machines only, are recorded and not dispatched.
- Dedicated agents still decline.
- Ticket intake and the eyes rule stay: one 👀 per agent that receives it. Context-only agents do not count.
- Chat-UI huddles (not Slack rooms) keep the old fan-out. `oneResponder` is opt-in per dispatch.

## Code

- `backend/src/services/slack/room-responder.ts`: `threadOwnerFromSlack`, `isDecisionCardText`, `findPriorRoomAnswer`, `heldReplyMessage`.
- `backend/src/services/chat-v2/room-context-backlog.ts`: the context-only queue.
- `ChatV2DispatcherService`: the `oneResponder` option in `computeHuddleTargets`. It returns `contextOnly`, which the dispatcher queues, and prompts drain the queue.
- `SlackTeamChannelService.routeInbound`: computes the pinned responder (decision, then Slack thread owner), passes `oneResponder`, and arms the fallback for an optional responder.
- `DecisionService.handleThreadReply`: memoised.
- `chat-v2.controller` `sendMessage` and `deliverReply`: the reply gate. The `--adds-new` flag is added to `reply-channel` and `reply`.

## Tests

- Incident replay: a thread reply that resolves D-92 reaches exactly one responder (Atlas, via the decision path). Ella gets context only and no delivery, and her next prompt in the room starts with the context block.
- Thread owner from the Slack thread: the card (only since the owner last spoke), else the last speaker. Includes the "looks off / I can dig into it / yes please do" probe. Ambiguous names are skipped.
- Liveness and ownership: a remote owner that is not live is not pinned, so the room owner answers by local rules and the other machine defers. A live remote owner means nobody here answers, but the room owner watches. An asker not in the room falls through. An unreadable thread is delivered only by the room owner machine.
- Top level: one awake agent is picked, the TL first. The others get context.
- 90 s hand-off: happens at baseline. It is skipped when the responder holds the message on its queue, or when Slack shows a reply or "working on it".
- Reply gate: held only after the chosen responder's answer. Covers the probes ("both" @'d, @'d in the answer, an earlier question owed). Recorded remote responder. `addsNew`. Interim posts. The text never suggests `--none`.
- Decision: a reply in more words than the choice is forwarded whole.
- Decision memo: one run per message.
