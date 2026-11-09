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
| `etaMinutes` | No | Your ETA for the whole task, in minutes. The first one you give for a WorkItem is compared with how long it actually took when you complete it |
| `taskKind` | No | The kind of task (`revision`, `new-build`, `new-capability`, `research`, `review`, ...) your ETA is for |

## Waiting for a known time

A progress note is not a place to wait. If the task can only proceed at a known time (a data window that closes at 08:30Z, a deploy that has to settle, a report that runs from a timer), do not hold the item `running` with "waiting for …" notes — your lead gets a "went quiet" review for every hour you hold it, and reporting it done early costs a retry. Block it with the `block-task` skill and its `until` parameter; the item comes back to you when the time has passed.

## Giving an ETA

Base it on your own median for that kind of task (shown at dispatch as "Your own task times" and in `get-my-context` as `taskTimings`), name the kind, and record it here, e.g. `{"progress":5,"current":"Starting the revision","etaMinutes":25,"taskKind":"revision"}`. Give a longer one only with a stated reason (new footage, a long render, waiting on the owner).

## Example

```bash
bash config/skills/agent/report-progress/execute.sh '{"sessionName":"dev-1","progress":60,"current":"Writing unit tests","completed":["Implemented API endpoint","Added validation"],"nextSteps":"Integration tests and code review","blockers":""}'
```

## Output

JSON confirmation that the progress report has been recorded.
