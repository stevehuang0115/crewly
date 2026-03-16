---
name: Accept Task
description: Accept and take the next available task from the task queue.
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
  - accept task
  - take task
  - get next task
  - pick up task
tags:
  - task
  - queue
  - assignment
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Accept Task

Accept and take the next available task from the task queue. The backend assigns the highest-priority unassigned task to your session.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | Your agent session name |
| `teamMemberId` | No | Your team member ID for targeted assignment |

## Example

```bash
bash config/skills/agent/accept-task/execute.sh '{"sessionName":"dev-1"}'
```

## Output

JSON with the assigned task details including path, description, and priority. Returns an empty result if no tasks are available.
