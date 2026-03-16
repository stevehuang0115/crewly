---
name: Get Tasks
description: Get task progress and overview for the team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - get tasks
  - task progress
  - show tasks
tags:
  - task
  - progress
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Tasks

Get task progress and overview for the team.

## Usage

```bash
bash config/skills/orchestrator/get-tasks/execute.sh
```

## Parameters

None required.

## Output

JSON with team task progress including assigned, completed, and blocked tasks.
