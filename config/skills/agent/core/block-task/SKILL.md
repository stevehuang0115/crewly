---
name: Block Task
description: Mark a task as blocked with a reason and optional questions for the orchestrator; with `until`, park it until a known time.
version: 1.1.0
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

If the task can only proceed at a known time (a report that needs a data window to close, a check after a deploy settles), block it with `until`: you keep nothing `running` while you wait, and the item comes back to you on its own when the time has passed. Do not report such a task done before it is, and do not hold it `running` while waiting.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workItemId` | Yes | The WorkItem you are blocked on (from your claim or `[CREWLY-DISPATCH]` message) |
| `reason` | Yes | Explanation of why the task is blocked |
| `sessionName` | No | Your session name (defaults to `CREWLY_SESSION_NAME`) |
| `questions` | No | Specific questions for the orchestrator to resolve the blocker |
| `urgency` | No | Urgency level: `low`, `medium`, `high`, `critical` |
| `until` | No | ISO 8601 time in UTC (`2026-10-27T08:30:00Z`), in the future. The block lifts on its own once it has passed: the item returns to `queued` for you (within about a minute of the time), and you take it before new work. |

Only a WorkItem you have claimed (`running`) can be blocked.

## What blocking does

- Your claim is released, so your claim slot is free and you can take other work.
  You do **not** need to `release-claim` it yourself to free the slot.
- Without `until`, the item stays `blocked` until someone unblocks it. It is not
  re-queued or re-dispatched to you automatically.
- With `until`, the block lifts on its own once that time has passed; the item
  returns to `queued` for you. Unblocking it earlier works the same as below.
  That return is your wake: do **not** also create a one-shot trigger for the
  same time. A trigger that fires first wakes you while the item is still
  blocked (you can still finish it, but the scheduled return never happens) and
  spends a wake for nothing.
- To unblock it (when the blocker is resolved), release it back to the pool with
  the `release-claim` skill (`POST /task-pool/release/:workItemId`). It returns to
  `queued` for you, and you take it before new work.

## Example

```bash
bash config/skills/agent/core/block-task/execute.sh '{"workItemId":"abc-123","sessionName":"dev-1","reason":"Missing production database credentials","questions":"Where are the DB credentials stored?","urgency":"high"}'
```

Work that can only proceed at a known time:

```bash
bash config/skills/agent/core/block-task/execute.sh '{"workItemId":"abc-123","sessionName":"dev-1","reason":"GA4 readout needs the full 7-day window; the data is complete after 08:30Z","until":"2026-10-27T08:30:00Z"}'
```

## Output

JSON confirmation that the WorkItem has been marked as blocked.
