---
name: Split Ticket
description: Move an ask that landed in another ticket's discussion out into its own ticket, keeping the thread link.
version: 1.0.0
category: task-management
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
  - orchestrator
  - team-leader
triggers:
  - split ticket
  - new ask in thread
  - separate ticket
  - TKT
tags:
  - ticket
  - intake
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Split Ticket

Every distinct ask from the owner should be its own ticket, so the owner can
say it and move on. Intake opens a new ticket for a new ask said in an
existing ticket's thread. When it is unsure, it **appends** instead, because a
ticket per stray remark is worse than a missed split. If an ask landed in a
ticket where it does not belong, split it out:

```bash
# See the ticket's follow-ups and their refs
bash execute.sh --ticket TKT-039 --list

# Move one of them out into its own ticket
bash execute.sh --ticket TKT-039 --discussion-ref slackch-C0C2QCGE9K9-1790433421.1

# Or open one from text (a pure information question: add --question)
bash execute.sh --ticket TKT-039 --text "research how Opus makes video" --assignee <session>
```

- The new ticket stays in the same thread and records the old one as its
  parent. Later follow-ups in that thread still find a ticket.
- `--question` means a pure information question. It gets no acceptance step.
- Split only a real new ask with its own deliverable. Answers, "好的",
  clarifications and "send it as a PDF" belong to the ticket they were said in.
