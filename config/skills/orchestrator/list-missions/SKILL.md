---
name: List Missions
description: List the company / team / project OKRs (Missions) with their approval state and Key Result progress. Use it at registration and whenever the owner asks "what are we working towards".
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
triggers:
  - list missions
  - what are our goals
  - okr status
tags:
  - okr
  - mission
  - goals
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# List Missions

Compact view of every Mission: id, level, objective, approval state, status,
parent, and the Key Results (current → target, status). Use `--full` for the
raw `GET /api/missions` payload.

```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/list-missions/execute.sh
bash {{ORCHESTRATOR_SKILLS_PATH}}/list-missions/execute.sh --pending   # only proposals awaiting the owner
```

## What to do with the result

- **Pending proposals** (`approval.state = pending_approval`): mention them to
  the owner the next time you talk. Do not execute, remind or decompose them.
- **No missions at all** and the teams have completed work in the last week:
  draft ONE company-level OKR from that work (objective + 2–3 Key Results
  that can be measured from something in the system — a ticket board, a
  build log, a folder count) and ask the owner whether to create it. Do not
  create it yourself.
- **Live missions with off-track KRs**: the hourly sweep already alerts the
  owner; you only act when a review WorkItem lands in your queue.
