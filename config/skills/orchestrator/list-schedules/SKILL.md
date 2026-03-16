---
name: list-schedules
description: List all active scheduled checks. Optionally filter by session name.
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
