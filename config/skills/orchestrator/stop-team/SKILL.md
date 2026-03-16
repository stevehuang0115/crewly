---
name: Stop Team
description: Stop all agents in a team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - stop team
  - deactivate team
  - shutdown team
tags:
  - team
  - management
  - lifecycle
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Stop Team

Stops all agents in a team.

## Usage

```bash
bash config/skills/orchestrator/stop-team/execute.sh '{"teamId":"abc-123-uuid"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |

## Output

JSON confirmation with team shutdown status.
