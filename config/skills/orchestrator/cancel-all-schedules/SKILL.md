---
name: cancel-all-schedules
description: Cancel all active scheduled checks. Optionally filter by session or age.
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
