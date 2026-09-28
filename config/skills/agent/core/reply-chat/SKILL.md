---
name: Reply Chat
description: Send a message to the Crewly Chat UI. Use this to post responses, updates, or notifications directly to a chat conversation.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
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
triggers:
  - reply chat
  - send chat
  - chat message
  - chat response
tags:
  - communication
  - chat
  - notification
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Reply Chat Skill

Send a message to the Crewly Chat UI. This is the preferred way for agents to post messages to the Chat UI.

## Usage

```bash
bash config/skills/agent/core/reply-chat/execute.sh '{"content":"Task completed","senderName":"dev-1"}'
```

### Flag-based

```bash
bash config/skills/agent/core/reply-chat/execute.sh \
  --text "Task completed" \
  --sender "dev-1" \
  --conversation "conv-abc123"
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--conversation` | `-C` | Chat conversation ID (optional — defaults to current) |
| `--text` | `-t` | Message text |
| `--sender` | `-s` | Sender name (required) |
| `--sender-type` | | Sender type (default: agent) |
| `--thread` | `-T` | Slack thread key from `[SLACK-THREAD:<key>]` in your prompt — the reply lands in exactly that thread |

## Slack threads: answer each in its own

A message from Slack carries `[SLACK-THREAD:<key>]` (e.g. `D0C31U6JWBF:1790392986.498639`).
Pass that key back with `--thread <key>`:

```bash
bash config/skills/agent/core/reply-chat/execute.sh --conversation <id> --sender <you> \
  --thread D0C31U6JWBF:1790392986.498639 --text "EFT 表改好了，附件是新版。"
```

- Two threads waiting on you → two replies, each with its own key. Never put
  the answers for different threads in one message.
- Finishing work that was asked for in an earlier thread? Post it with THAT
  thread's key, even if the owner has written in another thread since.
- Files go the same way: `attach-file --channel <id> --thread <key>`.

## Long jobs: say what you'll do first (`--interim`)

Before you start, decide how big the job is:
- **Quick:** do it and reply once.
- **Longer** (several steps, or more than about 3 minutes): first send a one- or two-line note with `--interim`. Say what you understood, how you'll do it, and roughly how long it will take. Then do the work and reply with the result.

In a Slack DM, the "is working on it…" line comes back under the note, and your final reply replaces it.

```bash
bash execute.sh --conversation <id> --sender <you> --interim --text "Got it: I'll compare the three quotes and draft a reply (~10 min)."
```
