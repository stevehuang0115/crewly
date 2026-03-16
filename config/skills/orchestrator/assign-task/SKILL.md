---
name: Assign Task
description: Assign a task to an agent via the task management system.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - assign task
  - give task
  - task assignment
tags:
  - task
  - assignment
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Assign Task

Assign a task to an agent via the task management system.

## Usage

```bash
bash config/skills/orchestrator/assign-task/execute.sh '{"taskId":"task-123","assignee":"agent-joe"}'
```

## Parameters

Pass the full JSON body as expected by `POST /api/task-management/assign`.

## Output

JSON confirmation of task assignment.
