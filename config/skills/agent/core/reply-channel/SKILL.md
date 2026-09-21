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
  [--thread <messageId>] \
  [--cmid <clientMessageId>]
```

`--thread` replies inside an existing thread. When the prompt you received
came from a **Slack team channel** it names the thread id
(`--thread <id>`); pass it through so your reply shows up in the same Slack
thread, under your own name.

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


## What not to put in a channel

A team channel is public — everyone in the workspace can read it. When your
answer would repeat something personal to the owner (mail, calendar, files,
health, money, anything from their private accounts), keep it out: say what
you did, not what it contained. "Reminder set for the 29th" instead of
naming the appointment.

If the answer cannot be given without that content, say so and ask where to
send it. Silence is recoverable; a disclosure is not.
