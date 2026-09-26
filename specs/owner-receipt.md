# Owner receipt — the nightly "小票" (#828, 2026-09-26)

Status: v1 implemented. The format is **not yet approved** by the owner. Builds on the ticket loop (`specs/ticket-loop.md`, #827: every ask becomes a ticket; `kind: question`; `parentTicketId`). Reference: Ava's hand-made receipt of 2026-09-26 (`.crewly/research/2026-09-26-owner-receipt/`).

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

## Format (renderer; Ava's posted receipt of 9/26)

```
*Crewly 小票 · 9/26 周六*（美东 0:00–21:00）      or（美东，上次小票 9/25 周五 21:00 起）
你提了 *N 件事*：✅ a · 👀 b · 🔄 c · ⛔ d · ✖ e    (zeros left out)
交付：PR x · issue y · 文件 z · 链接 w             (only when there are any)

*<team>*
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

## Not in v1 (from Ava's format note)

- The single "question to answer" per waiting item. Today it is the start of the agent's reply; agents do not yet record the question.
- A PR "ready to merge" marker, and checking each ✅ link at print time.
- Closely related asks sharing a line with an (n) count.
- The dashboard UI (the API is ready).
