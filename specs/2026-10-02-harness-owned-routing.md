# Harness-owned reply routing

Status: implemented on `fix/harness-owned-reply-routing`
Supersedes the routing parts of `2026-09-30-owner-message-guarantee.md` §B and
`2026-10-01-decision-cards.md` §6 where they conflict.

## Problem

Every agent→owner message must reach the conversation it belongs to. Which
conversation that is was decided by the agent (which tool, which ids), and
when the agent got it wrong the harness either guessed (global "current
conversation", the channel's latest thread, a top-level post) or quietly
filed the message as status for the orchestrator — and still answered
`success: true`.

### Incident (2026-10-02, TKT-187)

Owen (CE lead) was woken with
`[FOLLOW-UP TKT-187] … Post it in the same thread (--thread C0C2Y1FRCP7:1790897084.888289)`.
He ran `reply-chat --thread C0C2Y1FRCP7:1790897084.888289` with no
`--conversation`. `agentResponse`:

1. fell back to `getCurrentConversation()` — the globally newest chat, an
   unrelated `#crewly-marketing` huddle;
2. skipped the Slack-room branches (the conversation was not "named");
3. `deliverOwedAnswerToOrigin` returned null (nothing was owed for an
   unprompted follow-up);
4. filed the answer as status to the orchestrator and returned `success: true`.

The owner never saw it; Owen believed it was sent. The follow-up work item
carried the right origin all along. 15 substantive agent→owner messages were
lost the same way in ~12 hours (`Substantive agent content routed to the
orchestrator as status`).

Related gaps fixed here:

| Gap | Where | Before |
|---|---|---|
| a | `[FOLLOW-UP]`, `[DECISION]` prompts | raw `--thread C:ts`, no tool, no conversation |
| b | `reply` with no ids | newest RUNNING work item wins, even an unrelated trigger item; the (blocked) follow-up item with the right origin is skipped |
| c | `slack-post`, `resolveOutboundThreadTs`, `attach-file`, `upload-file` | a thread key for another channel is replaced by the latest root or a top-level post |
| d | placeholders, open items, ticket intake | ✅ on turn end without an answer; any post closes a promise; any owner reply accepts a ticket |
| e | `[DONE]` notice | posted to the agent's first-ever thread |
| f | Slack DM mirror | dropped silently when the owner last spoke elsewhere |

## Design

### 1. One destination resolver

`backend/src/services/orc/reply-destination-resolver.ts` (pure) and
`reply-destination.wiring.ts` (real collaborators + delivery).

Inputs are **references**, not places:

| Reference | Flag |
|---|---|
| a message the agent is answering | `reply --to <messageId>` |
| a ticket (request ticket `TKT-187`, or project ticket `CE-7`) | `reply --ticket <id>` |
| a work item | `reply --work-item <id>` |
| an owner decision card | `reply --decision D-12` |

Order (first that resolves wins):

1. the referenced message's conversation and thread;
2. the referenced ticket's thread — request tickets: their chat thread
   (`chatRef`, Slack thread from `origin.threadRef`); project tickets: the
   ticket→thread binding decision cards use (`ticket-thread-store`), created
   on first post when missing; a decision: its card's thread;
3. the referenced work item's origin / destination;
4. validated hints (below);
5. the reference the harness last prompted the agent about
   (`AgentPromptReferenceService`, set when a `[FOLLOW-UP]` / `[DECISION]`
   prompt is delivered) when it is newer than the agent's last owner turn;
6. the agent's current turn origin / current work (`planWorkDestination`);
7. the agent's owner DM.

An explicit reference that cannot be resolved is an error (the agent is told
which reference failed) — it never silently falls through to a guess.

**Hints.** Agent-supplied `--conversation`, `--thread`, `--channel` / target
are hints only. A hint is used when the harness can map it to a known
conversation the agent belongs to (its DM, a room it is a member of) and,
for a Slack thread key, the key's channel is that conversation's Slack
channel. A key whose channel differs from the named conversation/target is
not "fixed" by substituting the latest thread or a top-level post: the key
alone is tried as a hint; if it maps nowhere the agent belongs, every hint is
ignored (logged) and the order above continues.

Never: global current conversation, latest root, top-level because a key did
not match.

### 2. `reply-chat --thread C:ts` with no conversation

The Slack thread key is mapped to its chat-db conversation (team channel
mapping or DM link) and thread root, and delivered there as the agent.

### 3. No swallowing

`agentResponse` (behind `reply-chat`, `send-chat-response`, `report-status`):
content that is not a status marker reads as a message to a person. It goes
through the resolver. If it cannot be delivered the call returns
`success: false` (HTTP 409) with an English error naming the command to run
(`reply --ticket <id> "<text>"` / `reply --to <messageId> "<text>"`).
Status markers (`[DONE]`, `[BLOCKED]`, …) keep the orchestrator path.

### 4. Prompts name a command, not a place

`[FOLLOW-UP TKT-187] … Run: reply --ticket TKT-187 "<text>"`.
`[DECISION D-12] … Run: reply --decision D-12 "<text>"` (or
`reply --ticket <id>` when the decision belongs to a project ticket).
No raw thread keys. Delivering one of these prompts records the reference
for the agent, so a later `reply "<text>"` with no ids follows it instead
of an unrelated newest-running trigger item.

### 5. Honest "done" signals

- **Placeholders.** Turn end takes a placeholder down only when an answer
  was actually posted in that thread (`noteAnswerPosted`). Otherwise it stays
  and the owner-message watchdog handles it. `reply --none` (the agent
  explicitly says no answer is needed) still settles that thread's
  placeholder.
- **Open-item commitments** close only when the post plausibly fulfils the
  promise: a promise of a deliverable (preview, PDF, link, report, file, …)
  needs a link, an attachment or the same kind of thing named in the post; a
  plain promise needs a substantive post (not an ack or a progress line). A
  `reply --ticket` post is marked by the harness (`metadata.deliversTicket`)
  and counts as the delivery.
- **Ticket acceptance** — an owner reply on a 待验收 ticket has three
  outcomes (keeps the owner's 2026-09-28 decision that his reply decides,
  without letting a question count as a yes):

  | Owner reply | Outcome |
  |---|---|
  | approval-like (好 / 可以 / OK / approve / ship it / 👍 + the ACK / VERIFY aliases) | accepted, as before |
  | explicit send-back (打回 + the REJECT aliases) | reopened, as before |
  | anything else (a question, "where is it / send it again", "can you also…", "发了 请持续关注") | **neither**: stays 待验收, the message is kept in the ticket's discussion and delivered to the agent as an ordinary owner message it owes an answer to; the reminder / auto-accept clock (`submittedAt`) keeps running |

  An approval that cannot be taken yet (live work) still puts the agent back
  on the ticket, as before.

### 6. `[DONE]` notice and DM mirror

- `[DONE]` notices go to the thread the resolver gives for the report
  (work item → named thread → prompt reference → turn origin). No thread →
  no notice (never the agent's first-ever thread, never the owner DM).
- The Slack DM mirror posts unless the owner's latest turn is on another
  surface **and** recent (`DM_AFFINITY_FRESH_MS`) **and** the reply names no
  Slack thread. Skips are logged at info.

## Not in scope

- Orchestrator routing (`OrcReplyRouteService`) is unchanged.
- `ticket-review` Chinese reply prompt and chat-v2 dispatcher prompts still
  print `--channel/--thread`; those ids are the agent's own room and are now
  validated by the resolver rules above.
