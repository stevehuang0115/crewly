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
| `absoluteTaskPath` | Yes | Absolute filesystem path to the task file |
| `reason` | Yes | Explanation of why the task is blocked |
| `questions` | No | Specific questions for the orchestrator to resolve the blocker |
| `urgency` | No | Urgency level: `low`, `medium`, `high`, `critical` |

## Example

```bash
bash config/skills/agent/block-task/execute.sh '{"absoluteTaskPath":"/projects/app/tasks/deploy-api.md","reason":"Missing production database credentials","questions":"Where are the DB credentials stored?","urgency":"high"}'
```

## Output

JSON confirmation that the task has been marked as blocked and the orchestrator has been notified.
