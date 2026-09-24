---
name: Ticket Check
description: Read a ticket's acceptance criteria, or record your self-check of one criterion before you answer the owner.
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
  - acceptance criteria
  - self check
  - ticket criteria
  - TKT
tags:
  - ticket
  - acceptance
  - review
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Ticket Check

Messages from the owner that became a ticket carry a line like
`[TICKET:TKT-012 <id>]`. When you answer, the ticket goes to the owner as
待验收 (to review). The owner either accepts it (验过了) or sends it back
(打回) with a reason. Each reason is added to the ticket's acceptance
criteria.

Before you answer, read the criteria and check your work against them:

```bash
# List the live criteria (numbered from 0), with where each came from
bash execute.sh --ticket TKT-012

# Record your check of criterion 1
bash execute.sh --ticket TKT-012 --index 1 --result pass --evidence "ran the export; header row present"
```

- `auto` criteria can be shown by a build, test or scan. Check them and say
  what you ran.
- `judgment` criteria need the owner. Mark only what you actually verified.
- A criterion with source `reject` is something the owner already sent back
  once. Check it first.
