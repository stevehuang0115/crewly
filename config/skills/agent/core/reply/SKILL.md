---
name: Reply
description: Answer the message you are working on. It goes back where that message came from — Slack DM, Slack channel thread, or the Crewly chat/portal — without channel ids.
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
  - team-leader
triggers:
  - reply
  - answer
  - respond
tags:
  - communication
  - chat
  - slack
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Reply

Answer the message you are working on:

```bash
bash config/skills/agent/core/reply/execute.sh "EFT 表改好了，附件是新版。"
```

The harness remembers which message you are answering (the latest one
delivered to you) and sends your answer back there, over the right path:
the owner's Slack DM with you, the Slack channel thread, or the Crewly
chat / portal conversation. You do not pass channel ids or thread keys.

Keep the `CREWLY_SESSION_NAME=<you>` prefix when your prompt shows one — it
tells the system that you are the one replying.

## Options

| Flag | What it does |
|------|--------------|
| `"<text>"` / `--text` / stdin / `--text-file` | the reply |
| `--interim` | a short note before the real answer (what you understood, how long); "working on it" stays up |
| `--none` | nothing to answer (you answered elsewhere, or the message was not for you) |
| `--conversation <id>` / `--thread <key>` | only when your prompt tells you to answer somewhere specific |

## Rules

- Status lines (`[DONE] …`, `[BLOCKED] …`) still go to the orchestrator, as
  with `report-status`.
- Ids you pass that are yours (your DM, a room you are in) are used as given;
  missing or wrong ids fall back to where your message came from.
- If the reply cannot be delivered you get an error — nothing is dropped
  silently. Fix it and run the command again.
- `reply-channel`, `reply-chat` and `slack-post` keep working.
