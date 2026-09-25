---
name: WhatsApp Inbox
description: List the owner's WhatsApp chats that need a reply (last message not from the owner), with how many messages are unanswered. Read-only. 1:1 chats by default; groups are low priority.
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
  - whatsapp inbox
  - whatsapp messages to reply
  - who needs a reply on whatsapp
  - unread whatsapp
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

# WhatsApp Inbox

Which of the owner's WhatsApp chats are waiting on them.

```bash
bash execute.sh                        # 1:1 chats needing a reply, newest first
bash execute.sh --limit 50
bash execute.sh --include-groups       # groups too (noisy, low priority)
bash execute.sh '{"limit":20,"includeGroups":true}'
```

## Rules (owner decision — apply to every whatsapp-* skill)

- **Never send anything without the owner's explicit 「发 <code>」.** You may only
  write drafts (`whatsapp-draft`). Sending is one draft at a time, after the owner
  replies 「发 W12」 in chat or presses 发送 in the dashboard.
- **Never auto-reply to anyone.** Not even "got it" or "will get back to you".
- **Summarise; don't paste private chats wholesale** into Slack, team channels,
  the wiki, tasks, or any other place. Quote only the line you need.
- **Groups are low priority.** Look at 1:1 chats first; only surface a group
  when the owner is addressed directly or something is clearly urgent.

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--limit` (`limit`) | no | Max chats, default 20, max 200 |
| `--include-groups` (`includeGroups`) | no | Include group chats (default off) |

## Output

```json
{"count":1,"chats":[{"chatId":"4915550001@s.whatsapp.net","name":"Ann","isGroup":false,"unanswered":2,"lastKind":"text","lastFrom":"Ann","lastText":"at 8?","lastAt":"2026-09-24T18:02:11Z"}]}
```

`unanswered` counts messages from them since the owner last wrote in that chat.
`lastText` is cut to 200 characters; use `whatsapp-read --chat <chatId>` for the
conversation. `lastKind` is `text`, `image`, `document`, `audio`, `video`,
`sticker` or `other` (media is never downloaded — you see the caption only).

## Failures

`{"success":false,"reason":"…"}` (exit 1). An empty list with `count: 0` just
means nothing is waiting — or WhatsApp is not connected in inbox mode yet
(the owner connects it under Settings → WhatsApp).
