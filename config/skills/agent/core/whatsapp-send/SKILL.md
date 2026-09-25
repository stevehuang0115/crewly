---
name: WhatsApp Send
description: Send ONE WhatsApp reply draft that the owner has explicitly confirmed by replying 「发 <code>」. Fails with needs_owner_confirmation otherwise. Never use it on your own initiative.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - generalist
  - operations
  - ops
  - support
  - sales
triggers:
  - 发 W
  - send whatsapp draft
tags:
  - whatsapp
  - send
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# WhatsApp Send

```bash
bash execute.sh --draft W12
```

Use this **only** right after the owner has replied **「发 W12」** (or 「发送 W12」,
"send W12", 「确认发送 W12」) for that exact draft. One draft per call, one
message per draft.

## How the backend decides

The server checks the owner's own chat messages — which you cannot write or
fake — for 「发 W12」 sent **after** the draft was created. The draft must also be
less than **30 minutes** old. If either is missing you get:

```json
{"success":false,"sent":false,"reason":"needs_owner_confirmation","message":"NOT SENT: the owner has not confirmed. …"}
```

That is not an error to work around. Show the owner the draft (recipient, exact
text, code) and ask them to reply 「发 W12」. If the draft is older than 30
minutes, ask them to send it from the dashboard, or write a fresh draft.

Other failures: `draft_not_pending` (already sent or discarded — never resend),
`draft_not_found`, `not_connected`, `send_failed`.

## Rules (owner decision — apply to every whatsapp-* skill)

- **Never send anything without the owner's explicit 「发 <code>」.** A general
  "ok", "sounds good" or "handle it" is not a confirmation.
- **Never auto-reply to anyone.**
- **Summarise; don't paste private chats wholesale** into other channels.
- **Groups are low priority.**

## Output

```json
{"success":true,"sent":true,"code":"W12","recipient":"Ann","sentAt":"2026-09-24T18:05:00Z"}
```

Tell the owner it went out, in one line.
