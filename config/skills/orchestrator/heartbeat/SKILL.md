---
name: Heartbeat
description: Perform a system health check and heartbeat. Calls multiple API endpoints to update heartbeat via middleware and returns system status.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - heartbeat
  - health check
  - system status
tags:
  - monitoring
  - heartbeat
  - health
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Heartbeat Skill

Perform a system health check and heartbeat update.

## When to Use

Run this skill periodically (every 10-15 minutes) to:
- Keep the orchestrator heartbeat alive so the system knows you are responsive
- Get a quick overview of system status (teams, projects, message queue)

## Usage

```bash
bash config/skills/orchestrator/heartbeat/execute.sh
```

No parameters required.

## Output

Returns a JSON object with:
- `status`: "ok" if all endpoints responded
- `timestamp`: UTC timestamp of the check
- `summary`: team count, project count, queue pending/processing counts
