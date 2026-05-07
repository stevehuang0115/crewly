---
name: list-schedules
description: List all active scheduled checks (one-time and recurring), optionally filtered by session name.
version: 1.0.0
category: scheduling
skillType: claude-skill
assignableRoles:
  - orchestrator
tags:
  - schedule
  - audit
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# list-schedules

List all active scheduled checks (one-time and recurring).

## Usage

```bash
# List all scheduled checks
bash config/skills/orchestrator/list-schedules/execute.sh

# List checks for a specific session
bash config/skills/orchestrator/list-schedules/execute.sh '{"session":"agent-sam"}'
```

## Output

Returns a JSON array of scheduled checks with fields:
- `id` — Schedule ID
- `targetSession` — Target agent session
- `message` — Check message content
- `scheduledFor` — Next fire time (ISO)
- `isRecurring` — Whether it repeats
- `intervalMinutes` — Repeat interval (if recurring)
- `createdAt` — Creation timestamp
