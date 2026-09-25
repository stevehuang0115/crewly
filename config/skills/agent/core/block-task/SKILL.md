---
name: Block Task
description: Mark a task as blocked with a reason and optional questions for the orchestrator.
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
triggers:
  - block task
  - task blocked
  - stuck on task
  - need help
tags:
  - task
  - blocker
  - status
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Block Task

Mark a task as blocked with a reason explaining the blocker. Optionally include questions for the orchestrator and an urgency level.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workItemId` | Yes | The WorkItem you are blocked on (from your claim or `[CREWLY-DISPATCH]` message) |
| `reason` | Yes | Explanation of why the task is blocked |
| `sessionName` | No | Your session name (defaults to `CREWLY_SESSION_NAME`) |
| `questions` | No | Specific questions for the orchestrator to resolve the blocker |
| `urgency` | No | Urgency level: `low`, `medium`, `high`, `critical` |

Only a WorkItem you have claimed (`running`) can be blocked.

## What blocking does

- Your claim is released, so your claim slot is free and you can take other work.
  You do **not** need to `release-claim` it yourself to free the slot.
- The item stays `blocked` until someone unblocks it. It is not re-queued or
  re-dispatched to you automatically.
- To unblock it (when the blocker is resolved), release it back to the pool with
  the `release-claim` skill (`POST /task-pool/release/:workItemId`). It returns to
  `queued` for you, and you take it before new work.

## Example

```bash
bash config/skills/agent/core/block-task/execute.sh '{"workItemId":"abc-123","sessionName":"dev-1","reason":"Missing production database credentials","questions":"Where are the DB credentials stored?","urgency":"high"}'
```

## Output

JSON confirmation that the WorkItem has been marked as blocked.
