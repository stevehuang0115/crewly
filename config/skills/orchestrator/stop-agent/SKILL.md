---
name: Stop Agent
description: Stop a specific agent within a team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - stop agent
  - deactivate agent
  - shutdown agent
tags:
  - agent
  - management
  - lifecycle
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Stop Agent

Stops a specific agent within a team.

## Usage

```bash
bash config/skills/orchestrator/stop-agent/execute.sh '{"teamId":"team-uuid","memberId":"member-uuid"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |
| `memberId` | Yes | The member's UUID within the team |

## Output

JSON confirmation with agent shutdown status.
