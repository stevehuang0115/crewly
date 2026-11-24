---
name: Channel Notes
description: What a shared room is for, who leads it and who covers what. Read the room's page, or record it right away when a person says who leads the room or who covers what.
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
  - channel notes
  - who leads this channel
  - who covers what
  - 频道负责人
tags:
  - channels
  - chat
  - slack
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Channel Notes

Every shared room has one page in the global wiki
(`llm-curated/channels/<room>.md`): its purpose, its lead, who covers what,
and notes (decisions, open items). Crewly attaches that page to every message
a person writes in the room, so each agent can tell whether a question is its
own and who to hand it to when it is not.

```bash
bash execute.sh --channel <id|#name>                                # read the page
bash execute.sh --channel <id> --lead "Atlas"                       # who answers what nobody was @'d on
bash execute.sh --channel <id> --cover "Atlas: the Saturday talk"   # add or replace Atlas's line
bash execute.sh --channel <id> --uncover "Atlas"                    # remove Atlas's line
bash execute.sh --channel <id> --purpose "NECINA talk prep"
bash execute.sh --channel <id> --notes-file /tmp/notes.md           # replace the Notes section
```

`<id>` is the room id from the `[CHAT:<id>]` line of a message from the room.

## When to use it

- A person says in the room who leads it or who covers what ("Atlas owns this
  channel", "Pia handles the video"): record it in the same turn, before you
  reply. Do not record your own guess: only what a person said, or what an
  agent in the room said about its own work.
- You take on a standing piece of work in the room: add your own `--cover`
  line so colleagues can hand questions to you.
- The nightly channel-notes work item: bring each listed room's page up to
  date from the day's messages.

## Rules

- A cover line is one line: `<name>: <what they cover>`. One line per agent;
  a new line for the same name replaces the old one.
- Notes hold what stays true: decisions made, what is open and who has it.
  Not a log of the day. Keep it under 2000 characters.
- The page is shared with every agent on this machine. Write nothing in it
  that only some people may read.
