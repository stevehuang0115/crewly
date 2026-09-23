---
name: Get Tasks
description: Get task progress and overview for the team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - get tasks
  - task progress
  - show tasks
tags:
  - task
  - progress
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Tasks

Get task progress and overview for the team.

## Usage

```bash
bash config/skills/orchestrator/get-tasks/execute.sh
```

## Parameters

All optional, as JSON:

| Field | Meaning |
|---|---|
| `status` | One status or a comma-separated list, e.g. `"blocked"` or `"queued,running"` |
| `all` | `true` to include finished items (done, verified, cancelled, failed, rejected) |
| `target` | Only items assigned to this agent session |
| `limit` | Max items, newest first (default 50) |

By default you get pool stats plus the **open** items only, each as
`id, title, status, target, createdAt, blockedReason`. Keep it that way:
whatever this prints stays in your conversation and is re-read on every turn.
The whole pool can be several MB.

## Output

JSON with team task progress including assigned, completed, and blocked tasks.
