---
name: Start Agent
description: Start a specific agent within a team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - start agent
  - activate agent
  - boot agent
tags:
  - agent
  - management
  - lifecycle
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Start Agent

Starts a specific agent within a team.

## Usage

```bash
bash config/skills/orchestrator/start-agent/execute.sh '{"teamId":"team-uuid","memberId":"member-uuid"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |
| `memberId` | Yes | The member's UUID within the team |

## Output

JSON confirmation with agent startup status.
