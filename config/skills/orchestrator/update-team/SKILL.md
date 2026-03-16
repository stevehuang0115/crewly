---
name: Update Team
description: "Update an existing team's name, description, or configuration."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - update team
  - rename team
  - edit team
tags:
  - team
  - management
  - update
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Update Team

Update an existing team's name, description, or other properties.

## Usage

```bash
bash config/skills/orchestrator/update-team/execute.sh '{"teamId":"817a1aeb-...","name":"New Name","description":"Updated description"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team UUID to update |
| `name` | No | New team name |
| `description` | No | New team description |

## Output

JSON with the updated team data.
