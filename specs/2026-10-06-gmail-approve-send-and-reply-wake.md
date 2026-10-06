# Gmail: approve-then-send + wake on reply (CREW-257)

Owner request (Steve, 10/6): two Gmail gaps found by Lyra — (1) an agent can only leave a draft, the owner has no one-tap way to send it; (2) nothing wakes an agent when a reply lands.

## 1. Approve-then-send

Today `POST /api/google/gmail/send` from an agent creates a Gmail draft and holds it (`gmail-send-gate`). `POST /gmail/held/:id` (owner-only) sends it, but nothing puts a button in front of the owner, and `grantSendApproval()` has no caller.

Design — reuse decision cards (the `browser_action` pattern):

- New decision kind `gmail_send` (sensitive: `email`, so never auto-applied at the deadline; default option = Discard).
- `GmailSendApprovalService` (`services/google/gmail-send-approval.service.ts`):
  - `onHeld(hold)`: reads the draft, stores a **fingerprint** (sha256 of to/cc/subject/body) on the hold, raises a card showing recipient, subject and body preview, options **Send** / **Discard**.
  - `onSettled(decision)` (registered with `DecisionService.registerKindHandler('gmail_send')`): the only path that sends. Settling happens only through harness-delivered owner answers (button, reaction, thread reply, dashboard). On Send it re-reads the draft; if the fingerprint changed (owner or anyone edited it after the card) it **does not send**, raises a fresh card for the edited text, and tells the agent. If unchanged it calls `drafts.send` for that exact draft id, clears the hold, auto-watches the thread (feature 2) for the sending agent, and logs an audit line.
  - Approval is bound to the hold id `agent:draftId` and consumed on settle (a second settle finds no hold → no-op), so it cannot be reused.
- The agent cannot self-approve: no agent-callable route sends a held draft (`/gmail/held/:id` stays owner-only) and the one-shot `consumeSendApproval` path is removed from `gmailSend`.
- The owner route `POST /gmail/held/:id` answers through the card when one exists, so the card and the send never disagree.
- `gmail-send` skill output tells the agent a card was raised.

## 2. Wake on reply (revised 10/6: within 1 minute, history API)

Acceptance (Steve via Ella): the supplier replies, the owning agent is woken within **1 minute**. This replaces the hourly cron poll.

- Still polling (no Pub/Sub, no new OAuth scope; `gmail.readonly` already covers `users.history.list`).
- **Interval:** named constant `GMAIL_WATCH_POLL_MS = 30_000` in `constants.ts` (worst case wake = one tick + one fetch, far under 60 s).
- **Only while something is watched:** the timer starts when the first watch is added (or restored from disk at boot) and stops when the last is removed. No watches = no Gmail calls.
- **One `history.list` per tick per connected account** (`startHistoryId`=cursor, `historyTypes=messageAdded`, paged only if Gmail returns `nextPageToken`). It returns every message added mailbox-wide; entries are matched to watched threads locally. One `messages.get` (metadata) per *new matching* message to read From/labels, so quota use is ~2 units per tick idle plus ~5 per reply, far below limits (250 units/s/user).
- **Cursor:** `historyId` per account, persisted in `gmail-watches.json`. First watch for an account seeds it from `users.getProfile` (never fires for history). The cursor and the set of fired message ids are written to disk **before** the event is published (at-most-once): restart neither repeats a wake nor re-reads old history; a crash between write and publish can lose one wake, never duplicate one. Cursor only advances to the response's `historyId`.
- **Cursor expired (HTTP 404 from history.list, Gmail keeps ~1 week):** re-seed from the profile and run one `threads.get` per watched thread, firing for any message not in that watch's seen-set, so a long outage misses nothing.
- Event `gmail:reply_received`, `sessionName: gmail:<threadId>`, `threadId`, `newValue = messageId`, `target = ownerSession`; `watch-for-event ... --filter-json '{"threadId":"<id>"}'` wakes the agent. Messages labelled `SENT`/`DRAFT` are not replies. Only the connected account the watch was created under is polled.

## 1b. Card wording (revised)

Card text: **"Send this to <recipient>?"** + To / Subject / body preview; buttons **Yes** / **Not now**. Yes: the draft is sent (appears in the owner's Sent folder, audit-logged). Not now (or deadline, or withdrawn): nothing is sent, the draft stays in Gmail Drafts, the agent is told.

## Tests
Wake within 60 s of a new history record on a fake clock (30 s tick); no calls with zero watches; exactly one history.list per tick; cursor survives restart (no miss, no duplicate); expired cursor resync. Agent cannot self-approve; approval bound to one draft id and not reusable; edited draft after approval needs re-approval; event fires once per new message and not again after restart; only the connected account; skills documented.
