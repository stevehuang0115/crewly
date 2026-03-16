---
name: Read Task
description: Read the full details of a task file by its absolute path.
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
  - read task
  - view task
  - show task
  - task details
tags:
  - task
  - read
  - details
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Read Task

Read the full details of a task file by its absolute path. Returns the task content, metadata, status, and any subtasks.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `absoluteTaskPath` | Yes | Absolute filesystem path to the task file |

## Example

```bash
bash config/skills/agent/read-task/execute.sh '{"absoluteTaskPath":"/projects/app/tasks/implement-login.md"}'
```

## Output

JSON with full task details including description, acceptance criteria, priority, status, and related files.
