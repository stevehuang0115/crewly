---
name: Assign Task
description: "Assign a task to a specific agent via the task management system. Use when the orchestrator needs to target a particular agent with a known task ID. For agents self-assigning the next available task, use accept-task instead."
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

Assign a task to a specific agent via the task management system. The skill forwards the full JSON payload to the `POST /api/task-management/assign` endpoint, which records the assignment and notifies the target agent.

## When to Use

Run this skill when the orchestrator needs to assign a specific task to a known agent session. This is the formal task-tracking approach that goes through the management system's kanban board. For sending free-form work directly to an agent's terminal, use `delegate-task` instead.

## Parameters

The skill passes the full JSON input to the assignment endpoint. Common fields:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskId` | Yes | The ID of the task to assign |
| `assignee` | Yes | Target agent session name (e.g., `agent-joe`) |
| `reason` | No | Why the task is being assigned (recorded with the assignment) |

## Examples

### Assign a task to a specific agent

```bash
bash config/skills/orchestrator/assign-task/execute.sh '{"taskId":"task-123","assignee":"agent-joe"}'
```

### Assign with a reason for the assignment

```bash
bash config/skills/orchestrator/assign-task/execute.sh '{"taskId":"task-456","assignee":"agent-sam","reason":"owns the auth module"}'
```

## Output

JSON confirmation of the task assignment from the backend, including the updated task status and assignee details.

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| Input is empty | No JSON provided | Pass a JSON object with `taskId` and `assignee` |
| `curl failed with exit code N` | Backend not running or endpoint unreachable | Start the Crewly backend |
| HTTP 404 | Task ID does not exist | Verify the task ID with `get-tasks` |
| HTTP 400 | Invalid payload or agent not found | Check that the assignee session is registered |

## Related Skills

- `delegate-task` — send a task directly to an agent's terminal with monitoring
- `get-tasks` — list current tasks and their statuses
- `accept-task` — agent self-assigns the next available task from the queue
- `complete-task` — mark an assigned task as done
