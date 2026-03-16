---
name: Record Success
description: Record a successful pattern or approach so the team can replicate it in the future.
version: 1.0.0
category: memory
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - record success
  - successful pattern
  - what worked
  - note success
tags:
  - memory
  - success
  - patterns
  - best-practices
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Record Success

Record a successful pattern or approach so the team can replicate it in the future.

## Usage

```bash
bash config/skills/orchestrator/record-success/execute.sh '{"description":"Breaking large tasks into sub-tasks of 30 min or less reduced errors by 50%","projectPath":"/path/to/project","teamMemberId":"crewly-orc","context":"sprint-12 refactoring"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `description` | Yes | What succeeded and why it worked |
| `projectPath` | No | Path to the project where this succeeded |
| `teamMemberId` | No | Your session name |
| `context` | No | Additional context about when/where this succeeded |

## Output

JSON confirmation with the stored success entry.
