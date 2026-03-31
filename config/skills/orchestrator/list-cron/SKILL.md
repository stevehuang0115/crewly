---
name: List Cron Tasks
description: List all cron tasks, optionally filtered by agent or enabled status.
version: 1.0.0
category: scheduling
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - list cron
  - show cron tasks
  - view scheduled tasks
tags:
  - cron
  - scheduling
  - monitoring
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# List Cron Tasks

List all cron tasks registered in the Crewly backend.

## Usage

```bash
# List all cron tasks
bash {{ORCHESTRATOR_SKILLS_PATH}}/list-cron/execute.sh

# Filter by target agent
bash {{ORCHESTRATOR_SKILLS_PATH}}/list-cron/execute.sh '{"targetAgent":"agent-session"}'

# Filter by enabled status
bash {{ORCHESTRATOR_SKILLS_PATH}}/list-cron/execute.sh '{"enabled":"true"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `targetAgent` | No | Filter by agent session name |
| `enabled` | No | Filter by enabled status (`true` or `false`) |

## Response

Returns a JSON array of cron task objects with fields: `id`, `cronExpression`, `timezone`, `targetAgent`, `targetTeamId`, `taskDescription`, `enabled`, `lastRun`, `nextRun`, `createdBy`, `createdAt`.
