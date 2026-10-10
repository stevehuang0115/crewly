# Open items in agent replies

Status: implemented (OSS `feat/reply-open-items`)
Date: 2026-10-01

## Why

In #book-publish the owner asked Atlas (Think Tank lead) to use his podcast 「第二工位」 as
material for the book. The message was merged into ticket TKT-185 (request 729735dd), which
was already closed. Atlas replied in the thread with two open items:

- a promise: "Kai 在把四集逐条过一遍… 明天中午给我，我核过以后挑最有用的几条发你";
- a question: "第 13 章「互评当体检用」这个读法，你同意吗？不同意的话我就删掉，只留事实。"

Kai finished the material at 18:14 local (WorkItem 28b09370) and Atlas verified it. Nobody
delivered it, and Atlas went idle. Nothing tracked the question: decision cards only cover
asks made through `ask-owner`.

## 1. Extraction

Code: `services/open-items/open-item-extractor.ts`. It runs on every agent message in a
ticket's chat-v2 conversation. Every reply path (`reply`, `reply-channel`, `reply-slack`,
the chat agent-response) ends up as one of these messages. The message is read after the
ticket review has recorded it, so the two never write the ticket at the same time.

The extractor uses rules only, with no LLM. It is tuned to miss an item rather than invent
one:

| Item | Counts when | Skipped |
|---|---|---|
| Commitment | A deliverable for the owner (发你 / 给你 / 发在这里 / I'll send / share / follow up…) plus a future marker (明天, 今晚, 40 分钟后, 整理好, by Friday…) | Past tense (已经发你了, attached below), "here it is" (现在先给你), conditional offers (需要的话 / if you want), standing habits (以后每章都…), quoted or bracketed text, a third party as the subject (别人…回你), sentences addressed to a colleague |
| Question | The message's **last** question (2026-10-08): nothing after it but text in its own paragraph (how to answer, what happens on a yes) or later paragraphs of references / links / a sign-off. Ends in ？/?, is yes/no or either/or shaped (吗, 要不要, 是否, 还是, should I, do you want me to, … or …?), and is not inside quotes | Any question in the middle of a message; list items (bullets, numbered); questions under an interview / survey frame (问这几件事, 访谈, interview questions…); drafts between rule lines (`---`, `———`); self-answered questions (要不要…？要，…); rhetorical questions (难道…, 为什么…？因为…), headings, questions to a colleague (an @-mention of someone else, or a teammate's name up front), and open information questions (你们每周花多少小时？). A card can't answer those, and the agent sees the owner's reply anyway. |

**Due time** (local): an explicit time wins. "明天中午" is tomorrow 12:00, 傍晚 is 18:00,
"tonight" is 21:00, "40 分钟后" is +40 min, "下周三" is next week's Wednesday. "Tomorrow"
alone means tomorrow 12:00. With no time at all, it is +24 h.

Items are stored on the Request:

```
openItems: [{ id, type: 'commitment'|'question', text, agent, sourceMessageId, createdAt, status,
              due?, dueSource?, workItemId?, childWorkItemIds?, readyAt?, wokeAt?, nudgedAt?,
              ownerNotifiedAt?, decisionId?, answer?, closedAt?, closedReason? }]
```

Item status is one of:

- active: `open`, `ready`, `overdue`;
- closed: `delivered`, `resolved`, `superseded`, `expired` (7 days with nothing), `cancelled`.

## 2. The ticket is not done while an item is open

- New Request status `awaiting_followup`. `RequestService.update` turns every `done` into
  `awaiting_followup` while an item is active. This happens after the review gate, so a
  ticket that needs review still goes to 待验收 first.
- A ticket that was already `done` when its agent left an item in the thread moves to
  `awaiting_followup` (`reopenForFollowup`). That is the TKT-185 case.
- From `awaiting_followup` the only moves are to `done` (when the last item closes) and to
  `cancelled`. Status recomputes from WorkItems leave it alone, and so do the reconciler,
  the cascades, the ticket review's submit and the stale close.
- UI:
  - the Requests list shows the ticket as Active with "N open items";
  - the request page has an **Open items** card (promise or question, status, due time,
    decision id, answer);
  - `GET /api/requests/open-items` lists the active items.

## 3. Commitments

- **Follow-up WorkItem.** It is targeted at the agent, `owner: system`, and explicitly
  blocked (held), so nothing re-queues or dispatches it. Its title is "Follow-up for the
  owner (TKT-185): …". Its `metadata.origin` is the owner's thread, and it carries
  `metadata.openItemFollowUp`. It has no `requestId`, so it never takes the agent's
  one-ticket lock.
- **Child work.** The promise is linked to the WorkItems of the request (by `requestId`,
  `workItemIds`, or a 1.20.183 `metadata.origin` pointing at the thread) that meet all of
  these:
  - they were given to someone else;
  - they were created from 30 min before the promise to 15 min after it;
  - they had not already finished before the promise.

  Verify and follow-up items are not counted.
- **Early completion.** When the last child is `done`/`verified`, the agent is woken at once
  (`task:done`/`task:verified` events, plus the sweep):
  `[FOLLOW-UP TKT-185] The work you promised the owner is ready ("…") — deliver it now. You said: "…". Post it in the same thread (--thread C…:ts); that closes the follow-up.`
  The item becomes `ready`.
- **Delivered.** The commitment is delivered by the first post in the thread that meets
  both conditions:
  - it is from the promising agent, or from the agent who did the child work;
  - it comes after the child work finished.

  With no child work, a later post by the promising agent counts, as long as it comes at
  least 2 min after the promise and does not promise something new. The follow-up WorkItem
  is then closed as done.
- **Overdue.** When the due time passes, the agent is nudged once and the item becomes
  `overdue`. Two hours later, if it is still undelivered, the owner gets one note in the
  thread. The note is in the owner-message-watchdog style: harness text in English, the
  agent's own words quoted. Example:
  `Atlas promised "…" by 12:00. It hasn't arrived: Kai's part ("…") is still running. Atlas has been reminded.`
  The "why" names the child work that is still running, or says "the work was ready at
  18:17, but Atlas hasn't posted it", or "Atlas hasn't posted it yet".

## 4. Questions

- A question becomes a decision card through the decisions service. Its kind is the new
  `reply_question`. It is asked **as the agent**, and its new `place` field puts the card in
  the ticket's Slack thread (`origin.threadRef`). The deadline is the next day at 12:00. The
  card is not sensitive unless the question touches email, publish, deploy or spend.
- Options come from the text (`open-item-card.ts`):
  - a "no" fallback ("不同意的话我就删掉，只留事实", "If not, I'll…") gives **Yes** /
    **No** (detail: the agent's fallback). The default is No, because that is what the agent
    said it would do. `yesKey` is Yes, so "同意" or ✅ means Yes.
  - a "no objection" fallback ("没意见的话我就发") gives Yes (detail) / No, default Yes.
  - "A 还是 B？" or "Should I A or B?" gives A / B, default `wait`.
  - anything else gives Yes / No / Reply in thread, default `wait`.
- A question that points back at earlier text ("这样安排行不行？") carries a quoted context
  block on the card (`2026-10-02-decision-card-thread-answers.md` §5).
- Answers come through the existing decision flow: button, reaction, thread reply (text, or a
  voice note / file with no text) or the dashboard. The kind handler closes the item (`resolved`, with the answer) and passes the
  agent the usual `[DECISION]` note. Choosing "Reply in thread" tells the agent to wait for
  the owner's words in the thread.
- **No double card.**
  - When the agent already asked the same thing through `ask-owner` (bigram similarity
    ≥ 0.5 within 2 h), the item is linked to that decision instead.
  - When the agent asks through `ask-owner` after the card went up, `DecisionService.ask`
    withdraws the reply card (`superseded`), and the agent gets no note for it.
- While a question is on a card, the ticket review no longer nudges the agent to ask the
  owner again.

## 5. Prompt

Every agent prompt gets one line (`OPEN_ITEMS_CONSTANTS.PROMPT_LINE`): "If you promise the
owner something or ask them a question, say it plainly; Crewly tracks it. Use `ask-owner` for
real decisions."

## 6. Backfill

`services/open-items/open-items-backfill.ts` scans tickets updated in the last 7 days, except
cancelled ones. Each thread message is attributed to one ticket, the same way the live path
does it. The scan skips:

- promises that were already delivered later in the thread, by the live delivery rule;
- questions the owner replied to later in the thread;
- questions whose topic an agent later reported as settled in the thread ("done", "logged
  in", 「搞定」, 「登上了」 …);
- harness-flow questions: login / re-login prompts from crewly-orc, or naming a runtime.
  The harness tracks those itself;
- questions the owner already skipped in that request.

The cards it posts are marked `source: 'backfill'`, so `POST /api/decisions/skip-all
{"source":"backfill"}` clears exactly them (`2026-10-01-decision-skip.md` §3–4).

It runs as a **dry run by default**:

- `POST /api/requests/open-items/backfill`, which applies only with `{"apply": true}`;
- `node dist/backend/backend/src/scripts/open-items-backfill.js`, a read-only dry run against
  a running instance plus `chat.db`, which never applies.

## Constants

`OPEN_ITEMS_CONSTANTS` in `backend/src/constants.ts` holds:

- due defaults;
- the child window;
- the delivery gap;
- the owner-note delay;
- expiry;
- the dedupe window and similarity;
- the option labels;
- the prompt line.

## Addendum (PR 2): extractor accuracy and conditional promises

- **Not a promise:** a caveat or note about the work ("要说清楚的地方：…不一定…", "Note: this may need…"), a request for a go-ahead ("先问你：可以就让 Vera 做"), and "给你…的" used as a modifier. Past-tense restatements ("之前说…") are not new promises either.
- **Explicit dates win:** `10/7`, `10月7日`, `2026-10-07`, `Oct 7` set the due time (18:00 unless a part of day is named) over relative cues and over now + 24 h. A slash date that is not within the coming ~4 months is read as a ratio (`1/3`).
- **Waiting on the owner:** "你点头后…", "after you approve…" opens the item as `waiting_owner`: no due time, no follow-up WorkItem, no nudges. It opens (due counted from that moment) when the owner says yes in the ticket's thread, or when the ask-owner card the agent raised just before is answered yes; a no, or a cancelled/expired card, closes it as `superseded`.
  - **Gate (CREW-440).** When the same message also asks a question, that question's card is the gate: the promise carries `gateItemId` (the question item) and, once the card is posted, `gateDecisionId`. A card tap settles it at once (`onDecisionSettled`) and the sweep catches a missed handler call: Yes/defaulted opens it (follow-up WorkItem; the reconciler starts a stopped agent), Skip closes it as `skipped` and tells the agent once to drop it, No/cancelled/expired closes it as `superseded`; "Reply in thread" keeps it waiting for the typed yes. Promises stored before this (no gate fields) use the question of the same source message. A promise with no gate anyone can answer for 24h is surfaced to the owner once. `backfillWaitingPromises({ apply })` runs the same logic over existing requests (dry-run by default; applied once at startup).
  - **Auto-accept by silence** closes a waiting promise whose question was dropped instead of parking the ticket in `awaiting_followup`. Trace: an `awaiting_followup` ticket holding only waiting promises is reported as waiting on the owner (`followupWaitsOn: owner`), not on an agent.
- **Delivery that restates the promise** still delivers it and opens nothing new.
- **One promise, said twice** (same agent, within 30 min, same words or same person + same deliverable): the newer stands, the earlier is `superseded` and its follow-up cancelled.
- `adopt` (backfill apply) logs the caller session and the item count.
