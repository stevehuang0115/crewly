---
name: reply-channel
description: Send an agent-authored message back to a chat channel — used by the chat MVP dispatch loop after processing a `[CHAT:<channelId>]` prompt.
version: 1.0.0
category: comm
skillType: claude-skill
tags:
  - chat
  - comm
  - channel
  - reply
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# reply-channel

Send an agent-authored message back to a chat channel. Used by the chat MVP
dispatch loop: when an agent receives a `[CHAT:<channelId>] ...` prompt from
the user, it processes the request, then calls this skill to publish its
reply into the same channel.

## When to invoke

After you receive a message that begins with `[CHAT:<channelId>]` from the
dispatch runtime. The reply must be written to the same channel so the
user's chat UI sees it.

## Invocation

```bash
bash config/skills/agent/core/reply-channel/execute.sh \
  --channel <channelId> \
  --content "your reply text" \
  [--cmid <clientMessageId>]
```

Or with JSON:

```bash
bash config/skills/agent/core/reply-channel/execute.sh \
  '{"channelId":"chan-1","content":"hello back","clientMessageId":"cmid-abc"}'
```

## Environment

- `CREWLY_SESSION_NAME` — your agent session id. Auto-set in agent sessions.
  The skill attaches it as `X-Agent-Session` so the backend routes the
  reply as `senderType:"agent"`.
- `CREWLY_API_URL` — defaults to `http://localhost:8787`.

## Success / failure

On success prints `{"success":true, "messageId":"..."}` to stdout.
On failure prints `{"success":false, "error":"..."}` to stdout and exits
with a non-zero code.
