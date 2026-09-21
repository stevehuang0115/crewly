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

None required.

## Output

`{ success, stats, examined, workItems }`.

- `stats` — the pool's `/task-pool/stats` aggregate (totals by type/status).
- `examined` — number of pool rows fetched before filtering (the whole pool).
- `workItems` — only non-terminal items (status not `verified` / `done` / `cancelled` / `failed`), each compacted to `id, type, status, owner, target, title, createdAt, startedAt`. The full pool (3.5 MB on a busy install) is never printed.
- If the item list could not be fetched or was not an array, the skill prints `success:false` with an `error` and exits 1 — an unknown list is never reported as an empty one.
