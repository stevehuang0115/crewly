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

## Long jobs: say what you'll do first (`--interim`)

Before you start, decide how big the job is:
- **Quick:** do it and reply once.
- **Longer** (several steps, or more than about 3 minutes): first send a one- or two-line note with `--interim`. Say what you understood, how you'll do it, and roughly how long it will take. Then do the work and reply with the result.

In a Slack DM, the "is working on it…" line comes back under the note, and your final reply replaces it.

```bash
bash execute.sh --conversation <id> --sender <you> --interim --text "Got it: I'll compare the three quotes and draft a reply (~10 min)."
```
