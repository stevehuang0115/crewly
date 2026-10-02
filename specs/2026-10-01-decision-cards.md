# Decision cards + work-item destinations

Status: implemented (OSS `feat/slack-decision-cards`; Cloud half: crewly-services PR #24, auth 1.9.0)
Date: 2026-10-01

## Why

The owner answers from a phone. Until now, questions reached them two ways, both bad:

- The ticket autopilot batched every `needs-owner` question into one DM from the
  **orchestrator** ("3 tickets are waiting on you … reply `1 yes`"). It came from the wrong
  agent and the wrong place (not the ticket's thread). It also had no options, no default
  and no deadline, so an unanswered question blocked work for days.
- Agents asked free-form questions in whatever thread they were last asked in.

A related bug came from the same root. Atlas posted the output of a **scheduled** task
("steveswiki 第一次季度回看…") into an unrelated `#pro-think-tank` thread. The cause: the
1.20.170 `reply` sent answers to "the thread the agent was last asked in", and a cron run has
no asker.

## 1. The ask contract

The `ask-owner` action (in `project-tickets ask-owner`, the ticket autopilot brief, and the
new general `ask-owner` skill) requires:

| Field | Rule |
|---|---|
| `question` | One line, 8–280 characters. Not a bare "thoughts?"/"OK?"/"可以吗" — those are rejected as vague. |
| `options` | 2–3 options. Each has a short `label` (≤ 40 characters, unique) and an optional `detail` (≤ 150). On the CLI: `--option "Label"` or `--option "Label — detail"`, repeated. |
| `default` | An option (its label, key `a`/`b`/`c` or number `1`–`3`) or `wait`. |
| `deadline` | Optional ISO time, which must be in the future. Default: the next day at 12:00 local (`DECISION_CONSTANTS.DEFAULT_DEADLINE_HOUR_LOCAL`). |
| `ticket` | Optional ticket id, used with `project`. |
| `sensitive` | Optional: `email` (messages to outside people), `publish`, `deploy` (prod) or `spend`. |

A failed rule returns HTTP 400 with an error that says what to fix and gives a correct example.
Decisions are stored in `~/.crewly/owner-decisions.json` with ids `D-<n>`.

## 2. Who asks, and where

- **Ticket asks.** The asker is the ticket's assignee. With no assignee, it is the lead of the
  ticket's team (else the lead of the first project team). The orchestrator is never the asker
  of a ticket question. The card is posted **by the asker's own Slack bot** in its team
  channel:
  - in the ticket's thread when one exists (see `ticket-slack-threads.json`);
  - otherwise in a new thread whose root is `*APP-12 · <ticket title>*`. That thread then
    becomes the ticket's thread.
- **Non-ticket asks.** The asker is the caller. The card goes to the caller's current work
  item's destination (§6). When the work has no Slack destination, the card starts a new
  thread in the caller's team channel.
- **No bot token** (agent app not installed): the card is posted by the shared bot with the
  agent's name and icon.
- **The orchestrator's "Tickets waiting on you" DM is removed.** The evening digest still lists
  "Waiting on you" tickets, with a link to each card and no questions.

## 3. The card

```
[header]  APP-12 · Partner outreach email
[section] Send the draft to the 3 partners?
[section] • *Send Monday* — after the review call
          • *Hold* — wait for legal
[actions] [Send Monday] [Hold] [Remind me tomorrow] [Skip]
[context] If no answer by Thu 12:00, I'll wait. · D-7
```

The button `value` is `{"d":"D-7","o":"a","i":"<instanceId>"}`. Its `action_id` is `decision:a`
(`decision:remind` for the remind button). Cloud reads only `i`.

When the owner answers:

1. The card is updated in place, with the posting agent's bot token, to
   `✔ <owner> chose *Send Monday* · 14:05`, with no buttons.
2. The ticket log gets `owner decision D-7: Send Monday (button)`. The `needs-owner` label is
   cleared once no other open decision remains on the ticket.
3. The asker receives
   `[DECISION D-7] The owner chose "Send Monday" for: "Send the draft…?" (ticket APP-12). Act on it now. …`
   It is woken when stopped. The orchestrator gets it through its queue.
4. The decision is resolved.
5. The owner-message watchdog entries the asker owes in that thread are closed, so the owner
   is not nagged about a question they just answered.

**Other ways to answer.**

- Reactions on the card: ✅ means the default, or the first option when the default is `wait`.
  ❌ means an option that reads as "no" (No / Hold / Skip / 不要 …), when there is one. ⏰
  means remind tomorrow.
- A free-text reply in the card's thread, matched in this order:
  - an option label, key or number;
  - a yes word, which means the default (or the first option);
  - a no word, which means the "no" option;
  - a remind word, which means remind tomorrow;
  - anything else is passed to the asker verbatim as the owner's answer.

Only the owner can answer. That is the workspace installer or the `allowedUserIds`; anyone
else is ignored. Clicks on an already-settled card are ignored.

**Skip.** "I don't care about this anymore": the card shows `⤼ <owner> skipped this`, the
linked open item closes as `skipped`, the asker is told once to drop it and the same question
is not asked again for 30 days. Also 🚫 / ⏭️ and the replies `skip` / 「不用了」 / 「算了」 /
「不管了」; bulk `POST /api/decisions/skip-all`. See `2026-10-01-decision-skip.md`.

**Remind me tomorrow.** The card's context line becomes
`⏰ Reminding you tomorrow at 09:00 …`. At 09:00 local the asker's bot posts the question
again in the thread. The deadline moves to at least 24 h after the reminder.

## 4. Deadline

> Amended by `2026-10-02-decision-card-thread-answers.md`: a `wait` default posts nothing to
> the owner at the deadline (one actionable reminder later, at most); the default line names
> who acts; a moot card is withdrawn silently with a reason; voice notes and files in the
> card's thread answer it.

- **Default applies.** At the deadline the card is updated to
  `No answer by <deadline>, so <asker> went with "<default>".` The line
  `No answer by <deadline>, so <asker> will go with "<default>".` is posted in the thread,
  and the asker is told the default was applied. When the default is `wait`, nothing is
  applied and nothing is posted: only the asker is told to keep the work parked.
- **Sensitive asks** (`--sensitive email|publish|deploy|spend`) are never auto-applied. At
  `max(deadline, asked + 24 h)` the asker's bot re-asks once in the thread. 24 h after that
  the decision is **parked**: the card says so and the asker is told not to proceed. A parked
  decision stays in "Waiting on you" and can still be answered there.

## 5. Interactivity plumbing

- **Cloud transport** (crewly-services PR #24). Cloud verifies the Slack signature and
  forwards a `slack_event` relay message whose `event.type` is `block_actions` and whose
  `interaction` holds the full payload. `SlackService.handleCloudEnvelope` emits
  `interaction` (and `reaction` for `reaction_added`) instead of treating these as messages.
- **Socket mode** (env apps). Bolt `app.action(/^decision:/)` and `app.event('reaction_added')`
  emit the same events. The env app needs Interactivity on (Socket Mode delivers it) and the
  `reaction_added` bot event.
- **`POST /api/slack/interactivity`** accepts:
  - a Cloud envelope;
  - Slack's raw `payload=` form, but **only** with a valid `X-Slack-Signature` for the
    configured signing secret (`SLACK_SIGNING_SECRET`). Port 8787 is public on some servers.
    Without a configured secret it answers 401.
- **Checks on every click.**
  - The decision exists and is open.
  - The clicked message is the stored card (channel and ts).
  - The instance id `i` is this instance.
  - The user is the owner.
  - The update uses the token of the bot that posted the card.

## 6. Work-item destinations

The answer to a piece of work goes where that work came from, never to "the last thread
someone talked to me in".

| Work | Destination |
|---|---|
| Owner asked (Slack DM, room thread, chat) | That conversation / thread (the turn origin) |
| Ticket work (`metadata.projectTicket`) | The ticket's Slack thread, created on first post |
| Trigger / cron / auto work | The trigger's `destination` (new optional field: `#channel`, `C…`, or `C…:ts`). With none set, a **new top-level post** in the target's team channel, opened with a short topic line (`*<work title>*`). Never an existing unrelated thread. |
| Agent-initiated new topic | `reply --new-thread "<title>"` |

`reply` with no explicit ids continues **only the current work item's** origin. With no
current work item and no fresh owner message, it falls back to a new top-level post in the
agent's team channel. Explicit ids that are the agent's own still win.

The "current work" is the newer of:

- the agent's running work item;
- the last owner message delivered to it, if that message is less than 2 h old and newer than
  the work item.

The prompt guidance becomes one line: **"Answer where you were asked; a new topic goes in a
new thread."**

Some posts can't be made. If Slack refuses the post, or the agent has no team channel, the
reply falls back to the turn origin (the old behaviour). It does not fail silently.

Origins are recorded on the work item as `metadata.origin`:

- trigger work items: `{ kind: 'trigger', triggerId, destination?, teamId?, topic }`;
- cron work items: `{ kind: 'trigger', cronTaskId, teamId?, topic }`;
- ticket work items carry `metadata.projectTicket`, which is read as a ticket origin.

## 7. English harness text

Boot and restart notices ("✅ Crewly is back online (<machine>)", with Machine / Version /
Offline / Caught up lines), the welcome notice, the auto-update notices, the team-channel
welcome/roster/@-hint posts and the ticket-dismiss ephemeral are now English. Chinese input
aliases are still accepted everywhere.

## 8. UI

The Dashboard gets a **Waiting on you** card listing open and parked decisions. Each row
shows the question, its options as buttons, "Remind me tomorrow", the deadline and the ticket.
It is phone-friendly. Answering there resolves the decision exactly as a click in Slack does,
and the Slack card updates. API:

- `GET /api/decisions?status=open`
- `POST /api/decisions/:id/choose {option}`
- `POST /api/decisions/:id/remind`

## 9. Held browser actions (kind `browser_action`)

When the browser guard holds an irreversible click (send / submit / pay / delete / confirm /
publish / sign / Enter), Crewly asks for the agent: `BrowserApprovalService` creates a decision
with `kind: 'browser_action'`, `sensitive: 'browser_action'`, options **Let it** / **No**, default
**No**, `yesKey` Let it, and a deadline of 2 h (`BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS`). The
question names the agent, the control and the page: `Vera wants to click "Submit" on
visa.careerengine.us/subscribe — it looks like submitting and can't be undone.` The card has no
"Remind me tomorrow", and words that are neither yes nor no leave it open.

- **Where:** like any ask without a ticket — the thread of the agent's work item (work-item
  destination), else its team channel; posted by the agent's own bot.
- **Answers:** button, reaction (✅ = Let it, ❌ = No), thread reply (批准 / 可以 / 好 / yes = Let it;
  不行 / 不要 / no = No), the decisions dashboard, and the Browser page of the dashboard and the
  portal (`POST /api/browser/sessions/:id/pending/:pendingId` now answers through the card). All
  settle the same hold once; the card reads `✔ Steve chose Let it · 22:10`.
- **Applying:** the decision service calls the kind's handler on settle; the handler applies the
  outcome to the hold and writes the agent's `[BROWSER]` note (it replaces the generic
  `[DECISION]` note). Let it = the dashboard's approve: one pass for the agent's retry of the same
  call. Crewly does not replay the click.
- **Deadline:** the default (No) is applied — it never lets anything through, so unlike other
  sensitive asks it is not parked.
- **Durable:** holds are persisted in `CREWLY_HOME/browser-pending-actions.json` (no call
  params). After a restart a hold whose tab comes back in the extension's tab inventory within 2
  min is re-bound (`BrowserBridgeService.adoptTab`) and restored; the rest are marked `expired`,
  the card reads `Expired — Vera will ask again`, and the agent is told to redo the step.
- **Agent text:** the 409 `awaiting_owner` error tells the agent to say exactly "I've asked the
  owner with a card in this thread; wait for their answer." and stop (when Slack is down, it
  points at the dashboard's Browser page instead).

## Deploy order

1. Cloud: crewly-services PR #24 (auth 1.9.0). Slack verifies the interactivity URL, so it must
   be live first.
2. Owner, once, in api.slack.com for the master Crewly app:
   - Interactivity → On, Request URL `https://api.crewlyai.com/api/cloud/slack/interactivity`;
   - Event Subscriptions → add the bot event `reaction_added`.
3. Agent apps pick up interactivity through the Cloud manifest-upgrade queue (8 per run). To
   drain it now: `POST /api/cloud/slack/agents/manifest-upgrade`.
4. OSS release with this change. Without Cloud, cards still post, and reactions and replies on
   the socket path still work, but button clicks have nowhere to go.
