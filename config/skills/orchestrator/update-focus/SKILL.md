---
name: Update Focus
description: "Update the team's current focus area to align effort and communicate priorities."
version: 1.0.0
category: memory
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - update focus
  - change focus
  - set focus
  - team focus
tags:
  - memory
  - focus
  - planning
  - coordination
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Update Focus

Update the team's current focus area to align effort and communicate priorities.

## Usage

```bash
bash config/skills/orchestrator/update-focus/execute.sh '{"focus":"Stabilize authentication flow before adding new features","projectPath":"/path/to/project","updatedBy":"orchestrator"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `focus` | Yes | The new focus area description |
| `projectPath` | No | Path to the project this focus applies to |
| `updatedBy` | No | Who is updating the focus (e.g., "orchestrator") |

## Output

JSON confirmation with the updated focus entry.
