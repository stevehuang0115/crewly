# Owner receipt — the nightly "小票" (#828, 2026-09-26)

Status: v1 implemented; the Slack text was replaced by the calm receipt (#870, English since 2026-09-29), which the owner has not seen yet: the nightly send has been off since 9/28, and a one-time decision card now asks him to choose (§ Gaps, the format ask). The original **format was approved by the owner 2026-09-28** (「手动的小票，我觉得这个 OK，先这样子吧」, approving Ava's manual reference). Builds on the ticket loop (`specs/ticket-loop.md`, #827: every ask becomes a ticket; `kind: question`; `parentTicketId`). Reference: Ava's hand-made receipt of 2026-09-26 (`.crewly/research/2026-09-26-owner-receipt/`); a line-by-line comparison of the automated receipt against it is `.crewly/research/2026-09-26-owner-receipt/automated-vs-manual-2026-09-28.md`.

> **Superseded 2026-09-28 for the Slack text — see `specs/ticket-calm.md` §4.**
> The first automated receipt (14 asks, 17 「等你拍板」, TKT numbers, the owner's
> words cut off) overwhelmed him and he turned it off. The Slack message is now
> at most ten lines: *Done today* (≤3 outcomes in the agent's words, by the team
> that did it) and *Needs your decision* (≤3 questions + "N more on the board"),
> in English since the owner's 2026-09-29 decision; no ticket
> numbers, no raw owner text, no 不详/没记 lines; nothing is sent when there is
> nothing to say. The data layer below (asks, coverage, cost) still feeds
> `GET /api/owner-receipt`.

## Goal

Every evening the owner gets one phone-readable message:
- every ask he made, with its outcome and link;
- what is waiting on him;
- what it cost.

No manual assembly, and no LLM for any count.

## Layers (`backend/src/services/v3/owner-receipt/`)

| Module | Does | Never does |
|---|---|---|
| `owner-receipt-data.ts` | Builds `ReceiptData` from tickets and WorkItems (pure). Also holds the window, outcomes, deliverables and cost policy | Wording |
| `owner-receipt.renderer.ts` | `ReceiptData` → Slack mrkdwn (pure). **All wording and layout live here** | Read data |
| `owner-receipt.service.ts` | Settings, the send, the schedule tick, redaction of the final text | Format |
| `owner-receipt.boot.ts` | Slack owner-DM sender, team index, the interval | — |
| `controllers/owner-receipt/` | `GET /api/owner-receipt`, settings, send now | — |

The format can change in the renderer alone. The data layer can change (for example, a real cost source) without the renderer.

## Data

- **Window.** A parameter. **Default: since the last receipt.** The first receipt falls back to the local day so far. Local-day mode and an explicit `from`/`to` are available through the API.
  - *Decision awaiting the owner:* the local-day rule dropped 19 of his 9/25 evening messages, and anything asked after a 21:00 send would fall into a gap.
  - The window only moves when a send succeeds, so asks from a failed night appear in the next receipt.
- **Asks.** Numbered tickets created in the window, including split children and `question` tickets. **Each appears exactly once**, grouped by the team of its assignee; no assignee means 未分配.
- **Outcome**, from the ticket status and its WorkItems:

  | Outcome | When |
  |---|---|
  | ✅ `done` | The ticket is done; also an answered `question`, which has no acceptance step |
  | 👀 `to_review` | 待验收, waiting for the owner's OK |
  | 🔄 `in_progress` | Someone is on it |
  | ⛔ `blocked` | Blocked (the WorkItem's reason is shown when known) |
  | ⛔ `unowned` | No assignee and no WorkItem — the "nobody took it" case Ava found |
  | ✖ `dismissed` | The owner said 不用记 |

- **Deliverables.** Found in the agent's reply, the ticket result, and each WorkItem's output and result strings: GitHub PRs and issues, other links, and file paths under `.crewly/`, `ops/`, `specs/`, `reports/`, `docs/` or `~`. They are counted per kind.
- **Waiting on you.** Oldest first, whatever day it was asked:
  - every ticket in 待验收 (`waiting_confirmation` that needs review), with the start of the agent's answer as the question;
  - every WorkItem the reconciler escalated to the owner for review (#813, `reviewOwnerEscalatedAt`) that is still `done_by_worker`.
- **Cost.** Pluggable (`ReceiptCostSource`). The default, `cumulativeMeterCost`, **never prints a number it cannot stand behind**. `WorkItem.cost` today is a cumulative session meter (#812), so a non-zero value is the session's lifetime spend, not today's. It renders as 没记; no data at all is 没记 too, and never "$0". When a per-day source exists, the renderer prints `$x.xx` per team.

## Coverage — the receipt says what it covers (#828 review)

A receipt showing correct lines can still show only part of what the owner said. In the 9/26 replay, 13 of Ava's 31 asks got their own ticket. So the receipt states its coverage, right under the header, and never looks complete while silently showing part:

```
今天你发了 *43 条消息*：13 条成了事项 · 25 条并进已有事项 · 5 条没记（确认/寒暄）
```

- **Source.** Ticket intake records every owner message's fate in `<requests dir>/.intake-outcomes.jsonl` (`ticket-intake-log.ts`): `created`, `appended` (including 验过了 / 打回 / 不用记 into a ticket) or `ignored` plus the reason, with a timestamp. Duplicates (Slack redelivery) are not counted again. The file's first line is a `start` marker.
- **Unknown is 不详.** If the log does not exist, or began after the window started, the line reads 「你发了几条消息：不详（这段时间还没有开始记录）」 — never 0, and never left out. Every day before this shipped reads 不详, including the 9/26 replay over real stored data.
- **可能漏记.** An appended message whose words still carry request signals (the #827 ask score is above 0, even below the new-ask threshold) is listed with the ticket it went into, at most 5, then 「…另有 n 条」. Its redacted words are stored in the log only in that case. Pure acks score 0 and are never listed. The owner replies 「拆出来」; each entry's `splitCommand` in the API data is the `split-ticket` call that does it.
- **Replay of 9/26 with counting on:** 43 = 13 created + 25 appended + 5 ignored. 可能漏记 lists 10 messages, 8 of them among the 12 asks Ava counted that intake folded into another ticket.

## Safety

- Every text field is redacted with the shared secret patterns (`wiki-redaction.ts` `redactSensitive`): the ask, the question, and the deliverable refs.
- The final rendered text is redacted again before it is sent or returned.
- The owner's words are escaped for Slack in the renderer. Links are built there, so the sender does not escape the text again.

## Delivery

- **Slack DM** to the owner (`getOwnerUserId` → `openDirectMessage` → `sendMessage`, link previews off). When the owner's id is unknown or the DM fails, it uses the owner-notification path (`daily_summary`).
- **Schedule.** A check every minute (`OWNER_RECEIPT_CONSTANTS.TICK_INTERVAL_MS`). The receipt is sent once per local day, at or after the owner's time; if the backend was down at 21:00, it goes out when it is back that evening. The due check and the send share one queue, so a manual send racing a tick sends once.
- **Settings** (`~/.crewly/owner-receipt.json`): `enabled` (default true), `time` (`HH:MM`, default `21:00`), `timezone` (IANA, default `America/New_York`).

API (`/api/owner-receipt`):
- `GET /?from=&to=&mode=` — the receipt data and its text. This is the dashboard's source; the UI comes later.
- `GET /settings` — the settings and the last send.
- `PUT /settings` (plus a `POST` twin for the relay) — change the time, zone or on/off. **Owner only**: a call carrying `X-Agent-Session` is refused.
- `POST /send` — send now. **Owner only.**

## Original format (v1, no longer sent; Ava's posted receipt of 9/26)

```
*Crewly 小票 · 9/26 周六*（美东 0:00–21:00）      or（美东，上次小票 9/25 周五 21:00 起）
你提了 *N 件事*：✅ a · 👀 b · 🔄 c · ⛔ d · ✖ e    (zeros left out)
交付：PR x · issue y · 文件 z · 链接 w             (only when there are any)

*<team>（<lead>）*                                 (lead omitted when unknown: just *<team>*)
✅ <his words, shortened> → <link|label> · `file`   (≤ 3 per line, "等 n 项")
…                                                  (≤ 30 ask lines, then "…另有 N 件，见看板")

*等你拍板（K）*
1. TKT-036 <what> — <the question>                 (≤ 12, then "…另有 N 件等你")

*花费*：各团队都 没记（成本字段是会话累计值，不是当天花费，#812）
```

Slack mrkdwn, not a code block: CJK breaks monospace alignment on a phone, and links in code are not clickable (Ava's format note §8). Asks are one line per ticket; the text is the first line of the owner's message, cut at 56 weighted characters (CJK counts double). No LLM is used. An LLM may shorten the text later; the counts never need one.

## Replay — 2026-09-26 (`owner-receipt.replay.test.ts`)

The owner's 43 real Slack messages in Ava's window (0:00–14:00 EDT) were run through ticket intake (#827) and then this data layer:

- **Result:** 13 tickets. Ava counted **31 asks**, from 25 ask-opening messages.
- **Precision:** 13 of 13 tickets are messages Ava also counts as asks.
- **Recall:** 13 of Ava's 25 ask-messages were ticketed.
- **The gap:** 31 = 13 + 12 + 6.
  - **6:** Ava split 4 messages into 2–4 asks each. Here one message is one ticket.
  - **12:** messages intake appended to an existing ticket, per #827's rules:
    - 6 answer or approve the agent's own proposal in the same thread ("1. 修 2. …", "好的 开issue可以的", "要不发到文章上给我preview看看");
    - 4 are long spoken topic-A discussion;
    - 1 is a clarification;
    - 1 only looks top-level in the replay because its thread's ticket predates the window.

**Open question for the owner.** Is a directive that answers the agent, but has its own deliverable, a line on the receipt of its own (Ava's count) or part of the ticket it answers (#827's)? If his answer is "its own line", the receipt can list those follow-ups under their ticket, and the data layer already has them in `discussion`.

## Gaps to Ava's manual format (#856) — open until the owner chooses a format

#856 (filed 2026-09-28 13:40 UTC) listed six gaps between the nightly receipt and
Ava's manual reference of 9/26, the format the owner approved that day. #974 closed
it as superseded by the calm receipt (#870, `specs/ticket-calm.md` §4). That rested
on a receipt nobody had seen:

- the owner turned the nightly send off on 9/28 (`enabled: false`); the last send
  was 2026-09-29T01:00Z, so he has never received the calm receipt;
- the calm receipt is an agent-designed replacement; he approved the per-ask format,
  not this one.

#856 is reopened, and the format is the owner's call.

### The format ask (`owner-receipt-format-ask.ts`)

While the receipt is off, Crewly asks once, at the receipt's local send time
(default 21:00), on a harness decision card in the owner's DM (kind
`owner_receipt_format`, posted by this machine's orc bot):

```
[header]  Nightly receipt · try this format?
[section] This is what tonight's receipt would look like. Send it to you every night?
[section] > *Crewly receipt · Sat 10/3*            ← a real sample: the last 24 h
          > *Done today* …
[section] *Turn on nightly* sends this every night at the receipt time. *Keep per-ask format*
          leaves it off; the receipt you approved on 9/28 (every ask on its own line, with
          its outcome) gets built instead. Nothing is turned on unless you choose it.
[actions] [Turn on nightly] [Keep per-ask format]
```

| Answer | What happens | Recorded (`owner-receipt.json` → `formatAsk.answer`) |
|---|---|---|
| Turn on nightly | `settings.enabled = true`; the calm receipt goes out nightly | `nightly` |
| Keep per-ask format | stays off; the per-ask receipt (#856 gaps, including the summary step: "no LLM pass" is reopened) is the next work | `per_ask` |
| No answer within 3 days | the default (Keep per-ask) is applied: stays off | `no_answer` |
| Card withdrawn / expired | nothing chosen; asked again at the next send time | (cleared) |

- **Asked once.** An answered card is never asked again.
- **Blank sample.** When nothing in the last 24 h would be on the receipt, a blank
  sample shows nothing, so the ask waits for the next day.
- **Restarts.** An answer that arrived while the handler was not listening is applied
  on the next tick.
- **Never turned on for him.** The receipt is never enabled directly, only by his answer.

### The six gaps, by answer

| # | Gap | If "Turn on nightly" | If "Keep per-ask format" |
|---|---|---|---|
| 1 | Per-ask summary line with an (n) count and a free-text outcome | Not needed: "Done today" is ≤ 3 outcomes in the agent's own words (`summarizeOutcome`, which prefers Chinese lines; fine, as agent text is shown as is) | Needed: a summarisation step at send time (cost + latency every night) |
| 2 | ⏸ paused/parked outcome | Moot (no per-ask outcomes) | Needed: a `RequestStatus` for parked, rippling through the transition table |
| 3 | 交付 line: 6 specific categories | Moot (no counts) | Needed: path heuristics or live GitHub state |
| 4 | PR-ready marker, link liveness | Moot (no links) | Needed: I/O outside the pure renderer |
| 5 | Subagent names in team headers | Moot (no team headers) | Needed |
| 6 | Coverage line | Kept in `GET /api/owner-receipt` only | Kept on the receipt, as the approved format had it |
