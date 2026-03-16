---
name: Report Status
description: Proactively notify the orchestrator when a task is done, blocked, or failed.
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
  - report status
  - notify orchestrator
  - task done
  - task blocked
  - task failed
tags:
  - task
  - status
  - notification
  - orchestrator
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Report Status

Proactively notify the orchestrator when a task is done, blocked, or failed. Use this skill to keep the orchestrator informed without waiting for a scheduled check-in.

When `status` is `done` and a `taskPath` is provided, the task file is automatically moved from `in_progress/` to `done/` in the project's `.crewly/tasks/` directory.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | Your agent session name |
| `status` | Yes | Current status: `done`, `blocked`, or `failed` |
| `summary` | Yes | Brief description of what happened or what is needed |
| `taskPath` | No | Path to the task MD file; when provided with `status=done`, moves it to the `done/` folder |

## Example

```bash
bash config/skills/agent/report-status/execute.sh '{"sessionName":"dev-1","status":"done","summary":"Finished implementing auth module and all tests pass","taskPath":"/path/to/project/.crewly/tasks/delegated/in_progress/implement_auth_1234.md"}'
```

### Reporting a blocker

```bash
bash config/skills/agent/report-status/execute.sh '{"sessionName":"dev-1","status":"blocked","summary":"Waiting on API credentials from ops team"}'
```

### Reporting a failure

```bash
bash config/skills/agent/report-status/execute.sh '{"sessionName":"dev-1","status":"failed","summary":"Build fails due to missing dependency in package.json"}'
```

## Output

JSON confirmation that the status notification was sent to the orchestrator. If `taskPath` was provided with `done` status, also returns the task completion result.
