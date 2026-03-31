---
name: Update Cron Task
description: Update a cron task's schedule, description, or enable/disable it.
version: 1.0.0
category: scheduling
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - update cron
  - change cron schedule
  - disable cron
  - enable cron
tags:
  - cron
  - scheduling
  - automation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Update Cron Task

Update an existing cron task. You can change the schedule, description, timezone, target agent, or enable/disable it.

## Usage

```bash
# Change schedule
bash {{ORCHESTRATOR_SKILLS_PATH}}/update-cron/execute.sh '{"id":"cron-abc123","cronExpression":"0 10 * * 1-5"}'

# Disable a cron task
bash {{ORCHESTRATOR_SKILLS_PATH}}/update-cron/execute.sh '{"id":"cron-abc123","enabled":false}'

# Update description
bash {{ORCHESTRATOR_SKILLS_PATH}}/update-cron/execute.sh '{"id":"cron-abc123","taskDescription":"Updated task instructions"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | Yes | The cron task ID (from list-cron output) |
| `cronExpression` | No | New cron expression |
| `timezone` | No | New IANA timezone |
| `targetAgent` | No | New target agent session name |
| `taskDescription` | No | New task description |
| `enabled` | No | `true` to enable, `false` to disable |
