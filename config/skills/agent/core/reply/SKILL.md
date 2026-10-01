---
name: Reply
description: Answer the work you are doing. It goes where that work came from — the owner's Slack DM or thread, the ticket's thread, or a new top-level post for scheduled work — without channel ids. --new-thread starts a new topic.
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

**Answer where you were asked; a new topic goes in a new thread.**

The harness knows what you are working on and sends your answer where that
work came from:

| Your current work | Where the answer goes |
|---|---|
| a message from the owner | that conversation / Slack thread (DM, channel thread, Crewly chat / portal) |
| a project ticket | the ticket's thread in your team channel (started on the first post) |
| a scheduled / triggered task | the trigger's destination, else a NEW top-level post in your team channel |
| nothing in particular | a new top-level post in your team channel |

You do not pass channel ids or thread keys. A scheduled task's output never
lands in an old, unrelated thread.

To start a new topic yourself:

```bash
bash config/skills/agent/core/reply/execute.sh --new-thread "Wiki link audit" "Found 3 broken links: …"
```

Keep the `CREWLY_SESSION_NAME=<you>` prefix when your prompt shows one — it
tells the system that you are the one replying.

## Options

| Flag | What it does |
|------|--------------|
| `"<text>"` / `--text` / stdin / `--text-file` | the reply |
| `--interim` | a short note before the real answer (what you understood, how long); "working on it" stays up |
| `--none` | nothing to answer (you answered elsewhere, or the message was not for you) |
| `--new-thread "<title>"` | a new topic: a new top-level post in your team channel, opened with the title |
| `--conversation <id>` / `--thread <key>` | only when your prompt tells you to answer somewhere specific |

## Rules

- Status lines (`[DONE] …`, `[BLOCKED] …`) still go to the orchestrator, as
  with `report-status`.
- Ids you pass that are yours (your DM, a room you are in) are used as given;
  missing or wrong ids fall back to where your message came from.
- If the reply cannot be delivered you get an error — nothing is dropped
  silently. Fix it and run the command again.
- `reply-channel`, `reply-chat` and `slack-post` keep working.
