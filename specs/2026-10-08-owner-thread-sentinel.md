# An owner thread is never left silent (2026-10-08)

## Why

The owner-message watchdog (specs/2026-09-30-owner-message-guarantee.md)
covers the owner's *message*: once an agent answers, it stops watching. The
failure the owner kept hitting starts after that answer. The agent says "I'm
doing X, ~15 min", then gets stuck, and the thread goes silent.

2026-10-08, #pro-think-tank, Atlas: he said he would read the owner's email
attachments in Chrome. The browser held the click for approval (16:15). Crewly
restarted (16:33); the held action expired and Atlas was not restored ("no work
in hand"). A fresh Atlas held the action again (16:39), and decision card D-476
went **top-level** in the channel, not into the owner's thread. D-476 expired
silently at 16:51 and D-477 went top-level again at 16:52. The owner approved at
16:56, after asking "why no reply?". Earlier the same day: Vera finished but
replied in another thread, Ella never sent a finished draft, Sage worked for 30
min with no update, Nova's start failed silently, and Atlas and Ella were
stopped mid-conversation to free a slot.

## What

`OwnerThreadSentinelService` (`backend/src/services/messaging/owner-thread-sentinel.service.ts`)
and its wiring (`owner-thread-sentinel.wiring.ts`), state in
`CREWLY_HOME/owner-thread-sentinel.json`.

### Watched threads

A Slack thread (or DM) is watched for an agent while any of these is true
(within `ACTIVE_WINDOW_MS`, 6 h):

- the owner's latest message there is unanswered. The watchdog's `onTrack`
  feeds every tracked owner message, and hand-offs move it to the new agent;
- the agent's latest post there is a promise: "I'm …ing", "I'll / I will",
  "let me", "on it", "~N min", "ETA", 「正在 / 马上 / 等我 / 预计 / 稍后」, or a
  `reply --interim`. Agent posts come from the `reply` handler, the orc's
  Slack reply and `slack-post`;
- the agent's open work item came from that thread (owner origin);
- a card the agent waits on is open.

A final post from the agent (not a promise) clears the promise and the
work-origin mark.

### Blocking events → one status line in the thread

| Event | Source | Line |
|---|---|---|
| Card posted elsewhere | `DecisionService.postCard` → `onCardEvent` | ⏳ Atlas is waiting for your OK: … — Approve here (link) |
| Card posted in this thread | same | nothing (the card is the status) |
| Card expired | `expire` / settle → `onCardEvent` | ⚠️ Atlas's approval request expired before you answered (…). Atlas is asking again — the new card will show up here. |
| Card parked | sensitive re-ask, no answer | ⏸ Atlas is still waiting for your OK and has parked this … |
| Work blocked | `TaskPoolService.blockItem` (owner-origin or unstamped work) | ⏸ Atlas is blocked: … Your request is kept. |
| Stopped for a slot | `ResourceMode` pump | ⏸ Atlas was paused to free a slot for another agent; it resumes automatically when one frees (your request is kept). |
| Idle / pressure stop | `IdleDetectionService` | ⏸ Atlas was stopped to save memory while it looked idle; … |
| Start failed | `activateAgentBySession` (not deferred, not paused) | ⚠️ Atlas could not start: … reply here to try again. |
| Start deferred | `ResourceMode` start wait timed out | ⏳ Atlas is queued to start: this machine is at its running-agent limit … |
| Delivery held | input-blocked notices | ⚠️ Messages to Atlas are on hold: … |
| Crewly restarted | first tick after loading an active thread | 🔄 Crewly restarted while Atlas was on this. … |
| Promise overdue | tick: "~N min" and N×1.5 passed with no post | ⏱ Atlas said ~15 min, 23 min ago, and hasn't posted since. Right now: busy on "…". I've asked Atlas for an update here. |

Work-blocked and stop lines are skipped while a card is open. The card already
says why the agent waits, and the owner's answer wakes it.

A post by the orchestrator in a thread another agent owns ("Atlas is on it")
neither takes the thread over nor settles that agent's promise.

Lines are posted by Crewly's bot (an agent-owned DM: that agent's bot),
flagged `notAnAnswer`, and never mirrored to chat-v2. Harness text is English.

### Dedupe

- One line per state change per thread. The same state is never repeated
  while it is the last one posted, nor within `REPEAT_STATE_MS` (10 min) when
  states flap.
- Informational lines are at least `MIN_INFO_GAP_MS` (2 min) apart.
  Actionable ones (cards, start failed, overdue promise) are not held.
- At most `MAX_THREADS_PER_EVENT` (3) threads per agent-wide event.
- Any post by the agent in the thread resets the state.

### Card placement

`DecisionService.placeFor`: ticket thread → `place` → the work destination
when it has a thread → **the owner thread the asker owes**
(`ownerThreadOf`, the newest one active in the last 2 h) → the work destination without a thread → the team
channel. A browser-action card for owner work therefore lands in the owner's
thread instead of top-level.

### Expired browser approvals are asked again

On `card_expired` for a `browser_action` card, the thread gets the expiry line
and the sentinel waits `REASK_GRACE_MS` (3 min). If the agent has not posted a
new card by then and the thread still waits on it, the agent is nudged once to
redo the step, so a new card goes up. The agent is woken if it is down. Agents
the owner stopped and teams the owner paused are never woken.

### Promise deadline

When a promise states minutes, its deadline is `max(3 min, N × 1.5)`. Past the
deadline with no post, the sentinel posts one line saying what the agent is
doing now (its open work item and running / busy / idle state) and nudges the
agent once (`[OWNER THREAD <channel>:<ts>] … reply --thread …`). Promises over
8 h are not timed.

### Slot freeing and idle stops

`ResourceModeService.pickVictim` skips an agent that owes an owner thread (an
unanswered owner message or a promise in the last 30 min) whenever another
candidate exists. The idle-stop pending-work check counts the same thing as
work.

### Boot restore

`autoRestoreAgentSessionsIfEnabled` also restores every agent that an owner
thread waits on: a promise, an unanswered owner message or an open card. The
list is read from the sentinel's state file, together with the askers of open,
posted, non-system owner cards from the last 24 h. Both are read from disk,
because the restore can run before either service starts.

## Noise risks

- Promise detection is a heuristic. "I'll …" inside a final answer keeps the
  thread watched for up to 6 h. Lines still need a real blocking event, and
  only an explicit "~N min" is timed.
- Several agent-wide events close together (restart → deferred start → slot
  stop) are capped by the info gap and the per-thread state dedupe.
