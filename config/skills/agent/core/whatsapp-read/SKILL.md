---
name: WhatsApp Read
description: Read one of the owner's WhatsApp chats, search their WhatsApp messages, or list recent chats. Read-only. For summarising and preparing replies — never for forwarding private chats elsewhere.
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
  - read whatsapp chat
  - search whatsapp
  - what did they say on whatsapp
  - whatsapp conversation
tags:
  - whatsapp
  - inbox
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# WhatsApp Read

```bash
bash execute.sh --chat 4915550001@s.whatsapp.net            # newest 50 messages, oldest first
bash execute.sh --chat 4915550001@s.whatsapp.net --before 1760000000000   # page back (use nextBefore)
bash execute.sh --q "invoice"                                # search all chats
bash execute.sh --chats --q "ann"                            # find a chat by name
```

## Rules (owner decision — apply to every whatsapp-* skill)

- **Never send anything without the owner's explicit 「发 <code>」.** Reading is
  all this skill does; replies go through `whatsapp-draft`, and only the owner
  releases a draft.
- **Never auto-reply to anyone.**
- **Summarise; don't paste private chats wholesale** into Slack, team channels,
  the wiki, tasks, memory or any other place. Tell the owner what a chat is
  about and what is being asked; quote only the line you need.
- **Groups are low priority.** Skim them only when asked or when the owner is
  addressed directly.

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--chat` (`chatId`) | one of three | Chat JID (from `whatsapp-inbox` or `--chats`) |
| `--q` (`q`) | one of three | Search text; with `--chats`, filters chat names |
| `--chats` (`chats: true`) | one of three | List recent chats |
| `--limit` (`limit`) | no | Messages default 50 (max 500); search 20 (max 200); chats 50 (max 500) |
| `--before` (`before`) | no | Epoch ms; only older messages (paging) |

## Output

```json
{"chat":{"chatId":"4915550001@s.whatsapp.net","name":"Ann","isGroup":false},
 "messages":[{"at":"2026-09-24T18:01:00Z","fromMe":false,"sender":"Ann","kind":"text","text":"at 8?"},
             {"at":"2026-09-24T18:02:00Z","fromMe":true,"sender":"me","kind":"text","text":"yes"}],
 "nextBefore":null}
```

`fromMe: true` / `sender: "me"` is the owner. Media shows as its `kind`
(`image`, `document`, `audio`, `video`, `sticker`, `other`) with the caption or
file name as `text` — files are never downloaded. `nextBefore` is non-null when
there may be older messages; pass it as `--before`.

Search: `{"count":1,"hits":[{"chatId":"…","chatName":"Ann","at":"…","fromMe":false,"sender":"Ann","kind":"text","text":"…"}]}`

## Failures

`{"success":false,"reason":"chat_not_found","message":"…"}` (exit 1).
