---
name: Create Team
description: Create a new agent team with members.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - create team
  - new team
  - set up team
tags:
  - team
  - management
  - creation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Create Team

Creates a new agent team, with new members or empty.

## Usage

```bash
bash config/skills/orchestrator/create-team/execute.sh '{"name":"Alpha","description":"Frontend team","members":[{"name":"dev1","role":"developer","systemPrompt":"You are dev1, a developer on the Alpha team."}]}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Team name |
| `description` | No | Team description |
| `members` | Yes | Array of `{name, role, systemPrompt}` objects. `[]` creates an empty team to move existing agents into (`move-team-member`); a hierarchical team still needs a lead |

## Output

JSON with the created team details including team ID.
