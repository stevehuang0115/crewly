---
name: Complete Task
description: Mark a task as complete in the task management system.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - complete task
  - finish task
  - task done
tags:
  - task
  - completion
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Complete Task

Mark a task as complete in the task management system.

## Usage

```bash
bash config/skills/orchestrator/complete-task/execute.sh '{"taskId":"task-123","result":"success"}'
```

## Parameters

Pass the full JSON body as expected by `POST /api/task-management/complete`.

## Output

JSON confirmation of task completion.
