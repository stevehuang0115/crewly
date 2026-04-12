---
name: Cancel Cron Task
description: Permanently delete a cron task.
version: 1.0.0
category: scheduling
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - cancel cron
  - delete cron
  - remove cron task
tags:
  - cron
  - scheduling
  - cleanup
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Cancel Cron Task

Permanently delete a cron task from the Crewly backend.

## Usage

```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/cancel-cron/execute.sh '{"id":"cron-abc123"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | Yes | The cron task ID to delete |

## Notes

- This permanently removes the cron task. To temporarily stop it, use `update-cron` with `{"enabled": false}` instead.
- Only the orchestrator or the user can cancel cron tasks.
