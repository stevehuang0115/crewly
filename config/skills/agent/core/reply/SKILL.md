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

## Name what you are answering, not where

When your prompt names a ticket, a message, a work item or a decision, pass
that reference — the harness finds the conversation and thread:

```bash
# [FOLLOW-UP TKT-187] … Run: reply --ticket TKT-187 "<your message>"
bash config/skills/agent/core/reply/execute.sh --ticket TKT-187 "Preview is here: https://…"

# a specific message from your prompt
bash config/skills/agent/core/reply/execute.sh --to <messageId> "Yes — done."

# [DECISION D-12] … Run: reply --decision D-12 "<your message>"
bash config/skills/agent/core/reply/execute.sh --decision D-12 "Going with option A — starting now."
```

Order the harness uses: the message you name → the ticket's thread (request
ticket `TKT-…` or project ticket like `CE-7`) → the work item's origin → ids
you passed (only if they name a conversation you are in, and a thread key's
channel matches) → what the harness last prompted you about → where your
current turn came from → your DM with the owner.

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
| `--adds-new` | post even though the agent chosen to answer the owner here already replied. Without it such a reply is held and you see that answer. Use it when you have something new, or when you were asked (an @ in the owner's message or in that answer is never held) |
| `--new-thread "<title>"` | a new topic: a new top-level post in your team channel, opened with the title |
| `--ticket <id>` | the ticket you answer about (`TKT-187`, `CE-7`) — goes to that ticket's thread |
| `--to <messageId>` | the message you answer (from your prompt) — goes to its conversation and thread |
| `--work-item <id>` | the work item you answer about — goes where that work came from |
| `--decision <id>` | the owner decision you follow up (`D-12`) — goes to the card's thread |
| `--drive <session> --ack "<text>"` | Drive mode, FIRST, within seconds of the message: a short acknowledgement or the direct answer ("On it — about five minutes.") |
| `--drive <session>` | the owner is in Drive mode (listening on the phone, your prompt says `[Drive mode · session …]`): the full result goes to their phone, not Slack — conclusion first, at most 3 spoken sentences; a decision → 2–3 options; no URLs, tables or code; details go in your end-of-session recap |
| `--drive <session> --recap "<text>"` | after the Drive mode session ended: your ONE recap ("Drive mode recap — you said …; I did …; next: …"), posted in your DM with the owner (or the channel); it closes the conversation |
| `--conversation <id>` / `--thread <key>` | hints only: used when they name a conversation you are in (a thread key must be that conversation's channel); otherwise ignored |

## Rules

- Status lines (`[DONE] …`, `[BLOCKED] …`) still go to the orchestrator, as
  with `report-status`.
- Ids you pass that are yours (your DM, a room you are in) are used as given;
  wrong ids (a conversation you are not in, a thread key from another
  channel) are ignored, never swapped for "the latest thread".
- If the reply cannot be delivered you get `success: false` and the exact
  command to run — nothing is dropped silently, and nothing is filed as
  status for the orchestrator.
- `reply-channel`, `reply-chat` and `slack-post` keep working.

## Questions in your reply

- Crewly turns the **last** question of your reply into a tap-to-answer card when it is a decision
  for the owner ("这样写可以吗？", "Ship it today?"). Put the one question you need answered last.
- Questions in the middle, numbered lists of questions, quoted drafts and questions written for
  someone else (interview / survey questions, a script) get no card. Need several decisions? Ask
  each with `ask-owner`.
- A card that should not exist (it picked up a line that was not a question for the owner): withdraw
  it at once — `ask-owner --withdraw D-12 --reason "not a question for you"` (`ask-owner --mine`
  lists your open cards). The card closes and loses its buttons.
