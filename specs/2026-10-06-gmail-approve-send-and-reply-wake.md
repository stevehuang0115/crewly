# Gmail: approve-then-send + wake on reply (CREW-257)

Owner request (Steve, 10/6): (1) an agent drafts, the owner taps Yes, the email goes out; (2) when the supplier replies, the owning agent is woken within **1 minute**. Approved by Sam 10/6 (this version includes his changes). Spec lives in `specs/` (repo convention).

## 1. Approve-then-send

`POST /api/google/gmail/send` from an agent creates a Gmail draft and holds it (`gmail-send-gate`). The held draft is put to the owner as a decision card; the harness sends after the tap.

- Decision kind `gmail_send` (sensitive `email`, so never auto-applied; the safe default is "Not now").
- **Card:** "Send this to <recipients>?" with From, To, Cc, **Bcc**, Subject, body preview (first 700 chars), attachment names. Buttons **Yes** / **Not now**.
- **Only send path:** `GmailSendApprovalService.onSettled`, called by the decision service when an owner answer settles the card (button, reaction, thread reply, dashboard). No agent-callable route sends a held draft; the agent-keyed `grantSendApproval/consumeSendApproval` is removed.
- **Fingerprint** (sha256) covers everything that gets sent: from/sendAs, to, cc, **bcc**, subject, body **plain and html**, attachment names + sizes. It is taken when the card is raised and compared against the draft re-read at tap time. Any difference: nothing is sent, the hold is re-raised as a **new card showing the current content**, the agent is told. A settled hold or stale card cannot send again.
- **Yes** -> `drafts.send` for that exact draft id (lands in the owner's Sent folder), audit log line, auto-watch the thread (feature 2).
- **Not now** -> nothing sent, draft kept in Gmail Drafts, agent told.
- **24 h deadline** -> the card expires with the safe default: nothing sent, the draft is **not deleted** and stays untouched in Gmail; the agent is told "not approved in 24h, draft left in Gmail".
- **Only an owner tap on Discard deletes the draft** (`POST /gmail/held/:id {decision:'discard'}`, owner-only route -> `drafts.delete`). Not now and expiry never delete.
- The owner route `POST /gmail/held/:id {send}` answers through the card when one exists.
- `gmail-send` result carries `approvalCard` (false when Slack is not connected: the draft waits for the owner in Gmail).

## 2. Wake on reply — decision: `history.list` with a persisted historyId

(Earlier drafts said `threads.get` per thread; that is dropped except as the resync fallback below.)

- Polling, no Pub/Sub, no new OAuth scope (`gmail.readonly` covers `users.history.list`).
- **Interval:** named constant `GMAIL_WATCH_POLL_MS = 30_000` (`constants.ts`); wake latency <= one tick + one fetch, well under 60 s.
- **Only while something is watched:** the timer arms when the first watch exists (added, or restored from disk at boot) and stops when the last is removed. No watches = no Gmail calls.
- **One `history.list` per tick per connected account** (`historyTypes=messageAdded`, pages only on `nextPageToken`) however many threads are watched. Entries are matched to watched thread ids locally; one `messages.get` (metadata) only per new matching message, to read From/labels.
- **Cursor:** `historyId` per account in `gmail-watches.json`; first watch for an account seeds it from `users.getProfile` (history never fires). Cursor and fired message ids are persisted **before** the event is published (at-most-once: a restart never repeats a wake or re-reads old history; a crash in that window can lose one wake, never duplicate).
- **Resync fallback:** if Gmail answers 404 (historyId too old, ~1 week) the cursor is re-seeded from the profile and each watched thread gets one `threads.get`; any message not in that watch's seen-set fires. A long outage misses nothing.
- **Watch lifetime (cannot grow forever):** every approved send auto-watches its thread, and every watch **expires 14 days after its last reply** (or creation if none) — constant `GMAIL_WATCH_EXPIRY_MS`. Watches of an account that is no longer connected are removed (after 3 consecutive "not connected" ticks, so a transient Cloud outage does not wipe them).
- Event `gmail:reply_received`, `sessionName: gmail:<threadId>`, `threadId`, `newValue = messageId`, `target = ownerSession`; messages labelled `SENT`/`DRAFT` are not replies. `watch-for-event --event-type gmail:reply_received --filter-json '{"threadId":"<id>"}'` wakes the agent. **The event carries ids only.**
- **A reply is outside text:** the body is untrusted data, never instructions. `gmail-read`, `gmail-watch-thread` and `watch-for-event` SKILL.md say so.

## Tests
Self-approve impossible; approval bound to one draft id, not reusable; edit after approval (including **bcc added after the card**) -> no send + new card; 24 h deadline -> no send, draft not deleted; Not now keeps the draft; only Discard deletes. Fake clock: wake within 60 s of a new history record; zero watches -> zero calls; exactly one `history.list` per tick regardless of watch count; cursor survives restart (no miss, no duplicate); 404 cursor resync; watch expiry; disconnected account's watches removed; only the connected account. Mutation checks against `origin/main` per norm.
