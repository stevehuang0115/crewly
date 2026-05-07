---
name: cancel-all-schedules
description: Cancel all active scheduled checks, optionally filtered by session or age (nuclear cleanup).
version: 1.0.0
category: scheduling
skillType: claude-skill
assignableRoles:
  - orchestrator
tags:
  - schedule
  - cleanup
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# cancel-all-schedules

Cancel all active scheduled checks with optional filters.

## Usage

```bash
# Cancel ALL scheduled checks (nuclear option)
bash config/skills/orchestrator/cancel-all-schedules/execute.sh

# Cancel all checks for a specific session
bash config/skills/orchestrator/cancel-all-schedules/execute.sh '{"session":"agent-sam"}'

# Cancel checks older than 60 minutes
bash config/skills/orchestrator/cancel-all-schedules/execute.sh '{"olderThanMinutes":60}'

# Combine filters
bash config/skills/orchestrator/cancel-all-schedules/execute.sh '{"session":"agent-sam","olderThanMinutes":30}'
```

## Output

Returns `{"success": true, "data": {"cancelled": N}, "message": "Cancelled N scheduled check(s)"}`.
