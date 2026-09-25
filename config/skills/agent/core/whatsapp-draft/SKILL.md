---
name: WhatsApp Draft
description: Write a reply draft for one of the owner's WhatsApp chats. It is saved with a short code (W12) and NEVER sent — the owner releases it by replying 「发 W12」 or from the dashboard.
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
  - draft whatsapp reply
  - reply on whatsapp
  - write a whatsapp message
tags:
  - whatsapp
  - draft
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# WhatsApp Draft

Saves a proposed reply. **It never sends.**

```bash
bash execute.sh --chat 4915550001@s.whatsapp.net --text "Yes, 8 works — see you there"
bash execute.sh --chat 4915550001@s.whatsapp.net --text-file /tmp/reply.txt
bash execute.sh '{"chatId":"4915550001@s.whatsapp.net","text":"…"}'
```

## After drafting — what you must do

Show the owner, in your reply to them:

1. **who** it goes to (`draft.recipient`),
2. **the exact text** (`draft.text`),
3. **the code** (`draft.code`, e.g. `W12`),

and ask them to reply **「发 W12」** to send it (or 发送 / 丢弃 on the dashboard's
WhatsApp tab). Then stop. Only after they have replied 「发 W12」 may you run
`whatsapp-send --draft W12`. If they change the wording, write a new draft.

## Rules (owner decision — apply to every whatsapp-* skill)

- **Never send anything without the owner's explicit 「发 <code>」.** One draft,
  one confirmation, one message.
- **Never auto-reply to anyone** — no acknowledgements, no "will get back to you".
- **Summarise; don't paste private chats wholesale** into other channels. The
  owner needs the gist and your proposed reply, not a transcript.
- **Groups are low priority.** Draft for a group only when the owner asks.

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--chat` (`chatId`) | yes | Recipient chat JID; must already be in the inbox |
| `--text` (`text`) | yes* | Reply text (max 4000 chars) |
| `--text-file` | yes* | Read the text from a file instead |

## Output

```json
{"success":true,"sent":false,
 "draft":{"id":"…","code":"W12","recipient":"Ann","chatId":"4915550001@s.whatsapp.net","text":"Yes, 8 works — see you there"},
 "nextStep":"NOT SENT. Show the owner: recipient Ann, the exact text above, and code W12. Ask them to reply 「发 W12」 …"}
```

## Failures

`{"success":false,"reason":"chat_not_found"}` (exit 1) — you can only draft to a
chat that is in the inbox; find it with `whatsapp-read --chats --q <name>`.
