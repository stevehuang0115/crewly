---
name: Assign Ticket (TL)
description: Assign a project ticket (<project>/.crewly/tickets/) to one of your workers; the worker gets a linked WorkItem and is dispatched.
version: 1.0.0
category: task-management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - assign ticket
  - give this ticket to
  - backlog assignment
tags:
  - tickets
  - backlog
  - delegation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Assign Ticket (Team Leader)

Project tickets are the project's own backlog (see the `project-tickets`
skill). Workers take `ready` tickets themselves when they are idle; use this
when you want a specific worker on a specific ticket.

```bash
# Start work now: the ticket goes in_progress and the worker gets a WorkItem
bash {{TL_SKILLS_PATH}}/assign-ticket/execute.sh --project /path/to/project --id APP-12 --to worker-session

# Only record who will do it (no WorkItem yet)
bash {{TL_SKILLS_PATH}}/assign-ticket/execute.sh --project /path/to/project --id APP-12 --to worker-session --no-start
```

Rules the backend enforces:
- You must lead a team that works on the project.
- The worker must be on a team of that project (and on the ticket's `team`, if
  it names one).
- A ticket that is already in progress must be released first
  (`project-tickets release`), so two workers never hold one ticket.

When the worker completes the WorkItem, you review it through the normal
verification item; once you verify it the ticket moves to `done` by itself.
