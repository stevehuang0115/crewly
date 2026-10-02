# Decision cards: thread answers, quiet deadlines, honest labels

Status: implemented (OSS `fix/decision-card-answered-in-thread`)
Date: 2026-10-02
Amends: `2026-10-01-decision-cards.md` §3–4, `2026-10-01-reply-open-items.md` §4

## Incident (D-52, 2026-10-02)

- **00:05Z.** The orchestrator asked the owner in their DM thread:
  「关于在 CE 团队下加一个 codex agent 这件事——你看这样安排行不行？」. Open items carded
  it as D-52 (`reply_question`, default `wait`, deadline 16:00Z). The card showed only the
  question; "这样安排" pointed at earlier messages the card did not show.
- **00:30Z.** The owner answered in that thread with a Slack **voice message**. It got ✅
  and the watchdog tracked it for the orc, but D-52 stayed open:
  `handleThreadReply` read the empty `text` as "empty reply" and ignored it.
- **16:00:23Z.** At the deadline `applyDefault` posted `No answer by 12:00 — I'll keep
  waiting.` in the thread and told the orc to keep the work parked.
- **16:00:55Z.** The orc, woken by that note, knew the owner had already answered (the voice
  note) and withdrew D-52 and D-51 itself with `POST /api/decisions/D-52/cancel
  {"reason": "Moot: Steve said … (voice note in thread …)"}`. The controller only read
  `note`, so the reason was lost. Both cards turned into a bare `Withdrawn · 12:00`; the
  open items closed as `superseded` and TKT-032 closed ("every open item closed — ticket
  done").

So the root cause of the withdrawal was not a sweep: it was the asker reacting to the
deadline note about a question the owner had already answered in a form Crewly did not
count. The owner saw a "keep waiting" notice and, 30 seconds later, a bare "Withdrawn".

## 1. Any owner reply in the card's thread answers the card

`DecisionService.handleThreadReply` takes every owner message in the thread of an open card
(channel threads and DM threads alike), as long as it was posted **after** the card
(`ts` greater than the card's `messageTs`). Reactions are not messages and do not count.

| Reply | Result |
|---|---|
| Text | As before: option / yes / no / remind / skip words, else the words verbatim (`answeredVia: 'reply'`). |
| Voice note, audio, video, image or any other file with no text | `resolved` with `answeredVia: 'thread'`. The card reads `Answered in thread · <time>`. |
| Text + files | The text path; the file references are added to the note for the asker. |

For a `thread` answer the asker gets:

```
[DECISION D-52] The owner answered "…" in the card's thread with a voice message (no text).
Transcript (Slack): "…".   ← when Slack sent one
Files: Audio Clip.m4a (audio/mp4) <permalink>. Transcribe it with the transcribe-audio skill …
Read it as their decision and act on it.
```

Slack attaches a transcript to voice clips (`file.transcription.preview.content`, status
`complete`); when present it is stored as `answerText` and passed on. Otherwise the asker
gets the file reference and the `transcribe-audio` hint (the same hint the Slack bridge adds).
The answer files are stored as `answerFiles` (name, type, permalink).

Harness-owned (`system`) decisions and held browser actions still need an explicit answer:
a file or voice note does not settle them.

Every owner message in a card's thread (answer or not) stamps `ownerRepliedAt` on the open
cards there; §2's reminder uses it.

## 2. No owner-facing noise for a `wait` default

At the deadline of a non-sensitive `wait` card:

1. **Pre-check** (§3). When what the card tracks is already closed, the card is withdrawn
   silently.
2. **Nothing is posted in Slack.** Only the asker is told (`deadlineNoticeAt`):
   `[DECISION D-n] The deadline for "…" passed with no answer. Nothing was posted to the
   owner. Keep this work parked until they answer. If it is already settled or no longer
   needed, withdraw it: ask-owner --cancel D-n --reason "<why>".`
3. **One reminder, later.** `WAIT_REMINDER_DELAY_MS` (30 min) after that note, if the card is
   still open, the pre-check passes, and the owner has not posted in the thread since the
   card went up, the asker's bot posts once:
   `<@owner> Still waiting on you: <question> — tap an answer on the card above, or reply here.`
   (`waitReminderAt`). The delay gives the asker time to withdraw a moot card, so a notice
   followed by "Closed" cannot happen.

The bare `No answer by X — I'll keep waiting.` line is gone. The open card's context line for a
`wait` card says what to do: `Tap an answer or reply in this thread — I'll hold this until you
do.`

A non-`wait` default still posts a line, now saying who does what:
`No answer by 12:00, so Owen will go with "Hold".` (the settled card: `… so Owen went with
"Hold".`). The asker's name is its team-member name (`DecisionServiceDeps.displayName`).

"Remind me tomorrow" reminders and the sensitive re-ask run the same pre-check before posting.

## 3. Check before posting

`DecisionServiceDeps.trackedClosed(d)` returns why the card is moot, or null:

- `reply_question`: its Request is gone / `done` (`ticket done`) / `cancelled`
  (`ticket cancelled`), or its open item is no longer active (`already handled in this thread`).
- ticket asks: the project ticket is `done` / `cancelled`.

When it returns a reason, the tick withdraws the card (`cancelWhere(…, reason)`) instead of
posting anything; the asker is not woken for it.

## 4. Withdrawn cards say why

`cancelWhere(filter, note)` stores the note as `closedReason`. A cancelled card reads
`Closed — <reason> · <time>`:

| Note | Card |
|---|---|
| none | `Closed — no longer needed` |
| `ticket done` / `ticket cancelled` | `Closed — ticket done` / `Closed — ticket cancelled` |
| `already handled in this thread` | `Closed — already handled in this thread` |
| `superseded by D-7` | `Closed — replaced by D-7` |
| `cleared` | `Closed — cleared from the ticket` |
| anything else (the asker's words) | `Closed — <words, ≤ 120 chars>` |

`POST /api/decisions/:id/cancel` reads `note` or `reason`; `ask-owner --cancel D-7 --reason
"…"` passes it.

## 5. Cards stand on their own

When open items cards a question that points back at earlier text (「这样安排」, 「这个方案」,
「上面」, 「如上」, "this plan", "the above", "as discussed", …), the card carries a short
quoted context block under the question (`body`):

- the paragraph(s) of the same agent message before the question, up to ~300 characters;
- else, when the question is the whole message, the owner's original ask on the ticket
  (`Request.description`, else `title`), introduced as `Earlier in this thread:`.

Questions that stand on their own get no context block.

## Constants

`DECISION_CONSTANTS.WAIT_REMINDER_DELAY_MS`, `CLOSED_REASON_MAX_CHARS`;
`OPEN_ITEMS_CONSTANTS.CONTEXT_EXCERPT_MAX_CHARS`, `REFERS_BACK_PATTERNS`.
