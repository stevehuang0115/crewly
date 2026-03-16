---
name: Start Team
description: Start all agents in a team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - start team
  - activate team
  - boot team
tags:
  - team
  - management
  - lifecycle
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Start Team

Starts all agents in a team.

## Usage

```bash
bash config/skills/orchestrator/start-team/execute.sh '{"teamId":"abc-123-uuid"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |
| `projectId` | No | Project UUID to assign before starting (uses team's current project if omitted) |

## Output

JSON confirmation with team startup status.
