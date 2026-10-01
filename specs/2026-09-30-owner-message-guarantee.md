# Owner messages never go silently unanswered (2026-09-30)

## Why

The owner talks to Crewly from a phone (owner-away rule: they only read and
tap). On 2026-09-30 four different bugs each made an owner message vanish
without a word:

| Hole | Fixed in |
|---|---|
| Shared Slack room, everyone asleep → routed to nobody | 1.20.166 (room lead-wake fallback) |
| Agent answered through the wrong tool → swallowed as a status report | 1.20.168 (room members' substantive replies go to their thread) |
| "Working on it" placeholder depended on the agent | 1.20.165 (harness posts it) |
| Delivery to a stopped member 404'd, logged at debug only | — |

Each fix closed one hole. Nothing guarantees the end-to-end property: *every
message the owner sends to an agent gets either an answer, or a plain-words
note saying who it is waiting on and why.* This spec adds that guarantee (A)
and removes the most common cause of lost answers — the agent choosing the
wrong reply tool or ids (B).

## A. Unanswered-owner-message watchdog

`OwnerMessageWatchdogService` (`backend/src/services/messaging/owner-message-watchdog.service.ts`)
plus its wiring (`owner-message-watchdog.wiring.ts`).

### What is tracked

An owner message is tracked once it has been **delivered to at least one agent
on this machine**:

| Surface | Hook | Responsible agent |
|---|---|---|
| Slack DM to an agent's bot | chat-v2 dispatcher `onDispatched` | that agent |
| Slack room (team / ad-hoc channel), incl. the 1.20.166 hand-off | chat-v2 dispatcher `onDispatched` | first *required* recipient (@'d / last speaker / woken lead), else the room lead, else the first recipient |
| Portal / Talk / dashboard chat to an agent or huddle | chat-v2 dispatcher `onDispatched` | same as above |
| Slack message to the orchestrator (master-bot DM, legacy @mention route) | `SlackOrchestratorBridge` | orchestrator / mentioned agent |
| Dashboard chat to the orchestrator (`/api/chat/send`) | `sendChatMessageToOrchestrator` | orchestrator |

A message nobody here received is **not** tracked: the room fallback (1.20.166)
owns it. When that fallback hands the message to the lead and the dispatch
succeeds, the dispatcher hook tracks it then — under the same key, so there is
never a second entry and never a second wake.

Owner-ness: a `user` turn with no agent-author metadata
(`authorAgentSession` / `remoteAgentSession`); for Slack rows the Slack user
must be the workspace owner when that is known (same rule as
`isOwnerAuthored`).

Skipped (never tracked):
- pure acknowledgements — the whole message, normalised, is in
  `OWNER_MESSAGE_WATCHDOG_CONSTANTS.ACK_WORDS` (好 / 好的 / 嗯 / 收到 / 谢谢 /
  ok / thanks / 👍 …). Approval words such as 可以 / 行 are *not* in the list:
  they usually ask the agent to do something.
- a message already tracked or already resolved (dedupe key
  `slack:<channel>:<ts>` or `chat:<channel>:<messageId>`; resolved keys are
  remembered, bounded, and persisted).

### What clears an entry (the answer arrived)

Only what the owner can see counts.

- **Slack entries** (keyed by Slack channel + thread root):
  - any post by a Crewly bot (master or agent) into that thread
    (`SlackService` `outbound` event, text or file), except posts flagged
    `notAnAnswer` (placeholders, the watchdog's own note, the room-fallback
    note, the unknown-@mention hint);
  - a placeholder being edited into the answer or taken down by a file
    (`SlackTypingPlaceholderService` `onThreadAnswered`);
  - the placeholder being *settled* (the agent ended its turn deciding no reply
    was needed; the owner sees ✓/✅) (`onThreadSettled`);
  - a post in the thread by an agent on another machine (inbound Slack message
    with `authorAgentSession`).
- **Chat entries** (keyed by chat-v2 channel, plus thread for huddles): a
  non-user, non-interim turn recorded in that channel/thread. An interim note
  counts as a visible placeholder (see extension), not as the answer.
- An agent explicitly closing it with `reply --none` (no answer needed).

### Escalation timeline

Constants in `OWNER_MESSAGE_WATCHDOG_CONSTANTS`:

| Constant | Value | Meaning |
|---|---|---|
| `NUDGE_AFTER_MS` (T1) | 10 min | re-deliver to the responsible agent |
| `NOTE_AFTER_MS` (T2) | 20 min | post one note in the thread |
| `MIN_NOTE_GAP_AFTER_NUDGE_MS` | 5 min | a nudge always gets this long before the note |
| `BUSY_EXTEND_CAP_MS` | 60 min | longest a visibly-working agent is left alone |
| `TICK_MS` | 30 s | evaluation cadence |
| `STALE_DROP_MS` | 6 h | entries restored after a long downtime are dropped, not noted |

Every tick, for each entry (age = now − received):

1. **Working visibly** — a placeholder is showing in the thread (or an interim
   note in chat) **and** the responsible agent is mid-turn: wait, up to
   `BUSY_EXTEND_CAP_MS`. At the cap: post the note (no nudge — the agent is
   busy; a nudge would only queue).
2. **T1, not yet nudged** — nudge the responsible agent: a single
   `[REMINDER]` delivery carrying the conversation header (`[CHAT:<id>]`, the
   `[SLACK-THREAD:<key>]` tag), the original text (clipped) and the one-line
   instruction `reply "<text>"`. The orchestrator is nudged through its
   message queue (same header path as a normal Slack/chat message). A stopped
   agent is woken with the same user-initiated activation the dispatcher's
   activate-on-send uses (the owner's own message is the approval). If the
   agent cannot be reached (activation failed, delivery failed, login
   required) the nudge counts as **blocked** and the note is posted at once.
3. **T2 (and ≥ `MIN_NOTE_GAP_AFTER_NUDGE_MS` after the nudge)** — post ONE
   note in the thread / DM / chat channel and stop tracking. For
   optional-only deliveries (nobody @'d, the agents were only told) whose
   nudged agent then finished a turn without answering, the entry is closed
   quietly instead: after an explicit reminder that is the agent's judgement.

The note, from Crewly's own bot (master bot; for an agent-bot DM the master
bot cannot see, the agent's bot), in plain words:

- login needed → `⏳ Ella 还没回复你：她的 Claude 需要重新登录。回复「重新登录 claude」即可。`
- asleep / could not wake → `⏳ Ella 还没回复你：她没在运行，叫醒失败了（…）。`
- delivery error → `⏳ Ella 还没回复你：消息没送到（…）。`
- still working at the cap → `⏳ Ella 还在处理你这条消息（已经 60 分钟）。`
- otherwise → `⏳ Ella 收到了你的消息，但 20 分钟了还没回复；已经提醒过她。`

For chat entries the note is a `system` turn in that chat-v2 channel.

### Persistence, dedupe, logs, debug

- `<CREWLY_HOME>/owner-message-watchdog.json`: open entries + recently
  resolved keys (bounded to `MAX_RESOLVED_KEYS`). Loaded at boot; timers are
  tick-based, so a restart simply resumes the timeline.
- Each state change logs at `info`; a nudge, a blocked nudge and a note log at
  `warn` (`Owner message unanswered …`).
- `GET /api/system/unanswered-owner-messages` lists the tracked entries
  (surface, where, who, age, stage, preview).

### Interplay with existing mechanisms

- **Room fallback (1.20.166)** — untouched; the watchdog never tracks a message
  nobody here received, and a fallback hand-off re-uses the same key.
- **Placeholders / auto-working / settle** — reused as signals: a showing
  placeholder + busy agent extends; settle closes.
- **OrcDeliveryEnforcer** — unchanged (it nudges the orc to relay a
  sub-agent's [DONE]; different signal).

## B. Replies go back where the message came from

### Recorded origin

`OrcReplyRouteService` already records, for **every** agent, the turn origin
of its latest user-originated delivery (`[CHAT:<id>]` header). It now also
records the Slack thread key (`[SLACK-THREAD:<key>]`) and, from the
dispatcher, the chat-v2 thread the message sits in.

### `reply` — one entry point

`config/skills/agent/core/reply/execute.sh "<text>"` → `POST /api/chat/reply`.

`planAgentReply()` (`backend/src/services/orc/agent-reply-target.ts`) decides:

| Input | Goes to |
|---|---|
| status marker (`[DONE]`, `[WORKING]`, …) | the orchestrator, exactly like `report-status` |
| `--none` | nothing is posted; the watchdog entry for the origin is closed |
| explicit `--conversation` / `--thread` that are the agent's own | as given (explicit correct ids win) |
| missing, legacy or foreign ids | the recorded origin: its conversation + Slack thread key / chat thread |
| no origin known | 409 with a plain error — nothing is silently dropped |

Transport follows the origin conversation: the agent's DM (Slack DM mirror or
portal), a Slack room (as the agent's bot, in the thread), a plain huddle
(chat-v2 turn in the thread), or — for the orchestrator — its Slack thread
(`[SLACK:…]` marker, master bot) or its chat conversation.

### Tolerant legacy tools

`POST /api/chat/agent-response` (reply-chat): a *substantive* (non-status)
reply from a non-orchestrator agent that would otherwise fall into the
status-report path is delivered to that agent's origin **when the watchdog
says the agent owes the owner an answer there**. Without an owed answer the old
behaviour (status to the orchestrator) is kept, so delegation reports are not
redirected to the owner.

### Delivered instruction text

The dispatcher's reply hint starts with one line:
`回复: \`CREWLY_SESSION_NAME=<you> bash config/skills/agent/core/reply/execute.sh "<你的回复>"\` —— 会自动发回这条消息来的地方。`
The existing, more detailed reply-channel / reply-chat instructions stay after
it, so agents that already use them keep working.

## Not in scope

- 👍-reaction to close a thread (skipped; `reply --none` covers the agent side).
- Cross-machine watchdog coordination: each machine watches only what it
  delivered; answers from other machines are seen through Slack.
