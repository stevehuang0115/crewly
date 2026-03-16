---
name: Cancel Schedule
description: Cancel a previously scheduled check.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - cancel schedule
  - cancel reminder
  - remove check
tags:
  - scheduling
  - monitoring
  - cancellation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Cancel Schedule

Cancel a previously scheduled check.

## Usage

```bash
bash config/skills/orchestrator/cancel-schedule/execute.sh '{"scheduleId":"sched-abc123"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `scheduleId` | Yes | The schedule ID to cancel |

## Output

JSON confirmation of cancellation.
