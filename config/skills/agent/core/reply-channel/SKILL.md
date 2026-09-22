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

## Taking a message on: `--working`

Some messages are passed to you only so you can judge whether they concern
you — nobody @'d you, or a follow-up in a thread was aimed at whoever spoke
last. Your prompt says so.

If you decide to answer one of those, announce it **before** you start:

```bash
bash execute.sh --channel <channelId> --thread <messageId> --working
```

That shows "<your name> is working on it…" in the Slack thread, and your
reply — same `--channel` and `--thread` — replaces it in place. The owner
uses these to see who has taken a message on: if two agents decide to answer,
they should see two.

If the message is not for you, do nothing at all: no `--working`, no reply.
A placeholder you then never fill is worse than silence.

When you were @'d, or you are the one who must answer, you already have a
placeholder — `--working` is a harmless no-op and you can skip it.

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
