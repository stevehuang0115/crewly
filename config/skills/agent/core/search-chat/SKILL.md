---
name: Search Chat
description: Search the chat history you can see (your DMs, the channels and rooms you are in, messages that @-mention you) by keyword, channel and date range. Use it before telling anyone you cannot find an earlier conversation or request.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
  - researcher
  - devops
  - operations
triggers:
  - search chat
  - find earlier conversation
  - what did we say yesterday
  - search chat history
  - 搜索聊天记录
tags:
  - chat
  - history
  - search
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Search Chat

Your conversation restarts empty, but the chat log is kept. Before you tell
anyone you cannot find an earlier conversation or request, search it.

```bash
bash execute.sh --query "video plan"
bash execute.sh --query "video" --channel '#awesome-videos' --from 2026-10-09 --to 2026-10-09
```

| Flag | Required | Description |
|------|----------|-------------|
| `--query` / `-q` | Yes | Keywords; every word must appear (case-insensitive) |
| `--channel` / `-c` | No | Only this channel: `'#name'`, name or id |
| `--from` / `--to` | No | Date range, `YYYY-MM-DD` (a bare `--to` date includes that whole day) or a timestamp |
| `--limit` / `-l` | No | Most hits (default 10, max 30) |

Output: `{ "data": { "count": N, "hits": [ { "id", "time", "channelId", "channel",
"sender", "text", "threadId" } ] } }`, newest first. `text` is trimmed to
300 characters. `threadId` is the thread root, or null for a top-level message.

- You only see what you could see in chat: your DMs, the channels and rooms you
  are a member of, and messages that @-mention you.
- Try a shorter or different keyword when nothing comes back; CJK text is
  matched as written, without word splitting.
- To read around a hit, search again with `--channel` and a one-day range.
