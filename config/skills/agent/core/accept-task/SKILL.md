---
name: accept-task
description: "Accept and take the next available task from the task queue. Use when an agent is idle and ready to pick up the highest-priority unassigned task. For assigning tasks to specific agents, use assign-task instead."
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

Accept and take the next available task from the task queue. The backend selects the highest-priority unassigned task and assigns it to the requesting agent's session.

## When to Use

Run this skill when the agent is idle and ready to pick up new work. The backend automatically selects the highest-priority unassigned task. Without a `teamMemberId`, assignment is based on the session alone.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The agent's session name (e.g., `dev-1`) |
| `teamMemberId` | No | Team member ID for targeted assignment |
| `projectPath` | No | Project path to scope task selection |
| `taskGroup` | No | Task group to filter available tasks |

## Examples

### Accept the next available task

```bash
bash config/skills/agent/core/accept-task/execute.sh '{"sessionName":"dev-1"}'
```

### Accept with team member targeting

```bash
bash config/skills/agent/core/accept-task/execute.sh '{"sessionName":"dev-1","teamMemberId":"tm-abc123"}'
```

### Accept within a specific project and task group

```bash
bash config/skills/agent/core/accept-task/execute.sh '{"sessionName":"dev-1","projectPath":"/path/to/project","taskGroup":"frontend"}'
```

## Output

JSON object with the assigned task details including task ID, description, priority, and status. Returns an empty result if no tasks are available.

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required parameter: sessionName` | `sessionName` not provided | Include `sessionName` in the JSON input |
| `curl failed with exit code N` | Backend not running | Start the Crewly backend |
| Empty result | No unassigned tasks in queue | Wait and retry, or create new tasks |

## Related Skills

- `read-task` — view details of a specific task without accepting it
- `complete-task` — mark an accepted task as done
- `report-progress` — update progress on the current task
- `get-my-tasks` — list all tasks assigned to the agent
