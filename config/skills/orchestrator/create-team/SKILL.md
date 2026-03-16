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

Creates a new agent team with optional members.

## Usage

```bash
bash config/skills/orchestrator/create-team/execute.sh '{"name":"Alpha","description":"Frontend team","members":[{"name":"dev1","role":"developer"}]}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Team name |
| `description` | No | Team description |
| `members` | No | Array of `{name, role}` objects |

## Output

JSON with the created team details including team ID.
