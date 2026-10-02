# Ticket calm (2026-09-28)

Follow-up to `specs/ticket-loop.md` (#827 split, #831 review routing) and
`specs/owner-receipt.md` (#828/#832). The owner opened the first nightly
「Crewly 小票」 and found it overwhelming: 14 asks and 17 「等你拍板」, with TKT
numbers and his own words cut off mid-sentence. He turned it off
(`PUT /api/owner-receipt/settings {enabled:false}`).

Standing rules (owner, authoritative): tickets are internal — he never sees
ticket mechanics or numbers; agents ask for the OK in their own words;
「好的 / 可以」 accepts; silence accepts.

## Evidence (owner's Mac, 2026-09-29 01:00 UTC)

133 Requests in two folders: `crewly/.crewly/requests` (96: 43
`waiting_confirmation`, 48 done, 4 running, 1 cancelled) and
`~/.crewly/.crewly/requests` (37 `open`, all un-numbered test-leak Requests from
2026-08-08/22 — "hello orchestrator", "Test message").

1. **Over-ticketing.**
   - `ticket-intake.service.ts` (thread branch): a reply in a thread whose
     ticket is *finished* fell through to the top-level path. Every
     `communication` ticket closes on its answer (NO_REVIEW_CATEGORIES), so the
     owner's next reply in that thread became a new ticket: TKT-028 (in
     TKT-027's thread), 038/025, 039/037, 040/026, 041/035, 044/043, 049/048,
     064/063, 066/065, 072/052, 075/073, 076/074, 086/082, 087/083, 088/085.
   - A reply in a thread an **agent** started (morning brief, a question) has
     no ticket, so it was judged as a top-level message, and the top-level path
     creates a ticket for any L1+ intent even when the ask classifier says
     `not_ask`: TKT-067 「发了 请持续关注我的X吧」, 084 「A 论文那个 开个Issue吧
     放到backlog…」, 070, 071 「可以改到10:30吗」, 046, 020, 029, 059, 054, 077
     (all refs `…-msg-…`, i.e. thread replies).
   - `TRIVIAL_ACK_PATTERN` ended in `\W*`; CJK is all `\W`, so 「是绿卡」
     「对 就按第二种来 不用再问了」 read as a bare 「是」/「对」 and were dropped.
   - A Slack redelivery of an *appended* message was appended twice (duplicate
     check looked at `sourceConversationItemId` only).
2. **Pile-up in 待验收.**
   - Every answer went to 待验收 unless its intent was `communication`: "看看这个
     <link>", "这个团队都有几个人" waited for an OK nobody gives on a phone.
   - Auto-accept did fire (TKT-010, 011, 018 on 9/27–28) but took 72h+:
     `ticket-review.service.ts` sweep nudged at 24h, again 24h later, and only
     accepted 24h after the second nudge; any re-answer reset the chain.
   - TKT-017 can never close: two `rejected` verify WorkItems (superseded by
     their `:retry:1`) count as open children in the #467 gate, so `accept()`
     returns `open_work` on every sweep. The same `rejected` items kept TKT-021,
     053, 069, 092 in `running` (`openWorkItemCount` counted them).
3. **Wrong team on the receipt.** Ticket → team was `teamOf(assignee)` only.
   Tickets with no assignee that Owen (CE) answered were listed under 未分配;
   a ticket addressed to an agent on another machine (a shared room — e.g.
   `personal-assistant-team-ella-…`) but answered by Atlas was grouped under
   that other team. Answers recorded from another team's post in a shared
   thread (TKT-017: Ella's "Calendar ID?" recorded as the answer to Atlas's
   ticket; TKT-051) were shown to the owner as his decision.

## Rules

### 1. Follow-ups are not tickets (`TicketIntakeService`)

A message that belongs to a conversation with a ticket is appended to that
ticket's discussion. Only a **genuinely new ask** opens a ticket
(`isGenuinelyNewAsk`): the ask classifier's `new_ask` (questions stay in the
conversation), and either 「帮我…」-strength wording / a new topic, or longer
than `FOLLOW_UP.SHORT_REPLY_WEIGHTED_LENGTH` (24 weighted, CJK double).

- **Thread with a ticket** — open, 待验收, or finished within
  `FOLLOW_UP.RECENT_TICKET_MS` (3 days): append. On 待验收 anything that is not
  打回 is the owner's OK (accept + append); if it cannot be accepted (live
  work), the agent is back on it (reopen + append).
- **DM-like conversation** (`slack-dm`, `chat`, `portal`, `mobile`; every
  message top level): a reply within `FOLLOW_UP.DM_WINDOW_MS` (2h) of the
  conversation's latest ticket activity is its follow-up (short answers
  included; pure acks are not written).
- **Reply in a thread an agent started** (no ticket; `isThreadReply`): ignored
  (`thread_reply`) unless genuinely new — the agent gets the message anyway.
- Classifier: `ASK.DISPOSITION` (+3 follow in a thread) — backlog / 存下来 /
  记下来 / 放到 / 提醒我 is a decision about the thing just discussed.
- Acks: `TRIVIAL_ACK_PATTERN` tail is `[\s\p{P}\p{S}]*`, not `\W*`.
- A redelivered appended message is a `duplicate`.

Deterministic, no LLM. Over-appending is the cheaper failure: the agent can
`split-ticket`.

### 2. Only deliverables wait (`TicketReviewService`, `ticket-hygiene.ts`)

- **At answer time** (`submitAnswered`): `answerNeedsOwner` — the ask names a
  deliverable (`REVIEW.DELIVERABLE_ASK`: write/draft/email/doc/pdf/form/code/
  deploy/publish/send/pay/apply/implement/change…), the intent is
  `code_change`/`deployment`, or the answer asks him something (ends in ？ or
  `REVIEW.OWNER_QUESTION`). Otherwise the ticket closes as done, tagged
  `answered` (no `acceptedBy`: nothing was reviewed).
- **24h auto-accept**: `REVIEW.AUTO_ACCEPT_MS` = 24h, a hard deadline from
  `submittedAt`. One nudge (`MAX_NUDGES` 1, at `NUDGE_AFTER_MS` 12h) before it,
  so the agent asks in its own words. A failed nudge no longer holds it.
- **Dead WorkItems don't block acceptance**: `UpdateRequestInput.ignoreDeadChildren`
  (with `accepted`) lets `DEAD_WORK_ITEM_STATUSES` (`rejected`, `failed`) pass
  the #467 gate; live ones still block. `openWorkItemCount` (index.ts) counts
  live work only.
- **Stale close**: numbered `open`/`ready`/`running` with no activity
  (`ticketLastActivity`: created / updated / answered / submitted / discussed)
  for `STALE.AFTER_MS` (3 days) and no live WorkItem → `cancelled`, tag
  `stale`, a discussion note. The agent answering in its chat thread reopens it
  (`reopenStale`: the one allowed way out of `cancelled`, stale-tagged only).

### 3. One-time cleanup — `POST /api/tickets/cleanup`

Owner only; **dry run unless `{ "apply": true }`**; idempotent. Applies rule 2
to the existing pile (`runTicketCleanup`):

| action | condition | result |
|---|---|---|
| `answered` | 待验收, needs review, has an answer, `!answerNeedsOwner` | done, tag `answered` |
| `accept` | other 待验收 answered ≥ 24h ago | done, `acceptedBy: silence`, tag `auto_accepted` |
| `stale` | open / ready / running idle ≥ 3 days (incl. un-numbered legacy Requests unless `includeLegacy: false`) | cancelled, tag `stale`, note |

A ticket with a live WorkItem is reported under `failed` and left alone. The
endpoint uses the live `RequestService` (the project's requests folder); the
37 test-leak Requests in `~/.crewly/.crewly/requests` are outside it and
invisible on the board.

```bash
curl -s -X POST localhost:8787/api/tickets/cleanup -H 'content-type: application/json' -d '{}'              # dry run
curl -s -X POST localhost:8787/api/tickets/cleanup -H 'content-type: application/json' -d '{"apply":true}'  # apply
```

Dry run computed read-only against the owner's folders at 2026-09-29T01:59Z:
`crewly/.crewly/requests` (100 scanned) → answered 11, accept 14, stale 0
(18 待验收 left, all answered < 24h ago and needing a look — the sweep takes
them as they age); `~/.crewly/.crewly/requests` (37) → stale 37.

### 4. The receipt (`owner-receipt/*`)

At most ten lines, two sections, nothing else. The wording is English since
the owner's 2026-09-29 decision; the bullets carry the agents' own words:

```
*Crewly receipt · Mon 9/28*
*Done today*
• <team>: <outcome in the agent's words>        (≤ MAX_HIGHLIGHTS = 3)
*Needs your decision*
• <agent>: <the question he is asked>?          (≤ MAX_DECISIONS = 3)
N more on the board
```

This layout also closes #856 (the gaps to Ava's manual per-ask format); see
`specs/owner-receipt.md` § Gaps to Ava's manual format.

- **Done today**: numbered tickets done in the window (not stale / dismissed /
  misrouted), summarised from the agent's answer (`summarizeOutcome`: first
  Chinese line that says something; no links, paths, marks, lead-ins), ranked
  by made deliverables (file / PR / issue — links are what he sent), real work
  before questions, one per team first.
- **Needs your decision**: 待验收 deliverables answered within `DECISION_MAX_AGE_MS`
  (3 days) and not misrouted, plus WorkItems escalated to him (#813), oldest
  first; each is the last question in the answer (`ownerQuestionOf`) or
  "<outcome> — OK?".
- **Team**: `ticketTeamOf` — the assignee's team when the assignee is ours,
  else the answering agent's, else its WorkItems' target's; the orchestrator
  is `ORCHESTRATOR_LABEL`. `isMisrouted`: the recorded answer came from
  another team than the assignee's, or from an agent that is not ours.
- **Never**: TKT numbers, the owner's words, counts, coverage, cost, 不详/没记.
- **Skip**: nothing done and nothing waiting → `renderReceiptSlack` returns ''
  and nothing is sent (`reason: 'nothing_to_say'`); the window still moves.

The data layer keeps `teams` / `asks` / `coverage` / `waiting` / cost for the
API view (`GET /api/owner-receipt`); only the Slack text changed.

## Tests

`ticket-intake.service.test.ts` (thread / DM / agent-thread follow-ups,
confirmation replies, duplicates), `ticket-ask-classifier.test.ts`,
`ticket-review.service.test.ts` (plain answers close, 24h accept, one nudge,
stale close + reopen), `ticket-hygiene.test.ts` (rules, cleanup dry run /
apply / idempotent on a real RequestService), `request.service.test.ts`
(`ignoreDeadChildren`, `reopenStale`), `tickets.controller.test.ts`
(`/cleanup`), `owner-receipt-*.test.ts` incl. `owner-receipt.replay-2026-09-26`
and the new `owner-receipt.replay-2026-09-28` fixture shaped on the night of
the complaint.
