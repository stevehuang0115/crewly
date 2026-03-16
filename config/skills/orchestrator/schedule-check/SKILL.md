---
name: Schedule Check
description: Schedule a future check-in or reminder.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - schedule check
  - remind me
  - check in later
tags:
  - scheduling
  - monitoring
  - reminder
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Schedule Check

Schedule a future check-in reminder that will be delivered to your terminal.

## Usage

```bash
bash config/skills/orchestrator/schedule-check/execute.sh '{"minutes":5,"message":"Check on agent-joe progress"}'
```

### Recurring check

```bash
bash config/skills/orchestrator/schedule-check/execute.sh '{"minutes":10,"message":"Status report","recurring":true}'
```

### Recurring check with max occurrences

```bash
bash config/skills/orchestrator/schedule-check/execute.sh '{"minutes":10,"message":"Status report","recurring":true,"maxOccurrences":6}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `minutes` | Yes | Delay in minutes before the check fires |
| `message` | Yes | Reminder message text |
| `target` | No | Target session name (defaults to self) |
| `recurring` | No | When `true`, the check repeats every `minutes` interval (default: `false`) |
| `maxOccurrences` | No | Maximum number of times a recurring check fires (default: unlimited). Only used when `recurring` is `true`. |

## Output

JSON with the scheduled check ID and fire time.

## Best Practices

- **Always validate relevance** before acting on a scheduled check. If the agent or task it references is no longer active, cancel the schedule instead of performing the check.
- **Include context in the message** — mention the agent name and task so the orchestrator can quickly determine relevance when the check fires.
- **Use `maxOccurrences`** for time-bounded tasks to prevent stale schedules from running indefinitely.
