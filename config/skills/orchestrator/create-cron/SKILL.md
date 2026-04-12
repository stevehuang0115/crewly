---
name: Create Cron Task
description: Create a recurring cron task that sends work to an agent on a schedule.
version: 1.0.0
category: scheduling
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - create cron
  - schedule recurring
  - add cron task
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

# Create Cron Task

Create a recurring cron task in the Crewly backend. The cron evaluator runs every 60 seconds and sends `taskDescription` as a message to the `targetAgent` when the cron expression matches.

## Usage

```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/create-cron/execute.sh '{"cronExpression":"0 9 * * 1-5","timezone":"Asia/Shanghai","targetAgent":"agent-session","targetTeamId":"team-uuid","taskDescription":"Generate daily standup report"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `cronExpression` | Yes | Standard 5-field cron expression (minute hour day month weekday) |
| `timezone` | No | IANA timezone (default: UTC). Examples: `Asia/Shanghai`, `America/New_York` |
| `targetAgent` | Yes | Session name of the agent to receive the task |
| `targetTeamId` | Yes | Team ID the agent belongs to |
| `taskDescription` | Yes | The task message sent to the agent when cron fires |

## Cron Expression Examples

| Expression | Meaning |
|------------|---------|
| `0 9 * * 1-5` | 9:00 AM weekdays |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * 0` | Midnight every Sunday |
| `0 8,17 * * *` | 8 AM and 5 PM daily |

## Notes

- The cron evaluator auto-starts offline agents before delivering the task
- Tasks are stored in `~/.crewly/teams/{teamId}/cron-tasks.json`
- Created tasks are enabled by default
