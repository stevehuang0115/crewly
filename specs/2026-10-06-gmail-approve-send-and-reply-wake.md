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

## 2. Wake on reply

Polling, not Pub/Sub (no new OAuth scope; reuses the existing `gmail` grant, `threads.get` metadata).

- `GmailReplyWatchService` keeps `~/.crewly/gmail-watches.json`: per watched thread `{ threadId, ownerSession, account, seen[] }`.
- Watches are added by an approved send (auto) or `POST /api/google/gmail/watch {threadId}` (skill `gmail-watch-thread`), baseline = messages already in the thread (never fires for history).
- Every 60 s each watched thread is read; a message id not in `seen`, not labelled `SENT`/`DRAFT`, is a reply. `seen` is **persisted before** the event is published (at-most-once: a restart cannot re-fire it).
- Only for the connected account the watch was created under: a watch whose account is no longer connected is skipped.
- Event `gmail:reply_received` on the event bus, `sessionName: `gmail:<threadId>`` (self-events are not delivered to the publisher's own session), `threadId`, `newValue = messageId`, `target = ownerSession`. `watch-for-event --event-type gmail:reply_received --filter-json '{"threadId":"<id>"}'` wakes the agent (signal triggers match on payload fields; `threadId` and `target` are added to the emitted payload).

## Tests
Agent cannot self-approve; approval bound to one draft id and not reusable; edited draft after approval needs re-approval; event fires once per new message and not again after restart; only the connected account; skills documented.
