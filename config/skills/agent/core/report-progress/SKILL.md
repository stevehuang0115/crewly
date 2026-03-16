---
name: Report Progress
description: Report progress on the current task with percentage, completed items, and next steps.
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
  - report progress
  - status update
  - progress update
  - sync status
tags:
  - task
  - progress
  - status
  - sync
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Report Progress

Report progress on your current task. Includes a completion percentage, what you are currently working on, completed items, and next steps.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | Your agent session name |
| `progress` | Yes | Completion percentage (0-100) |
| `current` | Yes | Description of what you are currently working on |
| `completed` | No | Array of completed items |
| `nextSteps` | No | Description of planned next steps |
| `blockers` | No | Description of any blockers encountered |
| `ticketId` | No | Associated ticket or task ID |

## Example

```bash
bash config/skills/agent/report-progress/execute.sh '{"sessionName":"dev-1","progress":60,"current":"Writing unit tests","completed":["Implemented API endpoint","Added validation"],"nextSteps":"Integration tests and code review","blockers":""}'
```

## Output

JSON confirmation that the progress report has been recorded.
