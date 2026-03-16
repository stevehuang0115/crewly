---
name: Record Learning
description: Quickly record a learning or discovery while working on a task.
version: 1.0.0
category: memory
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - record learning
  - learned that
  - note discovery
tags:
  - memory
  - learning
  - quick-note
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Record Learning

Quickly record a learning or discovery. Simpler than `remember` — good for jotting down learnings.

## Usage

```bash
bash config/skills/orchestrator/record-learning/execute.sh '{"learning":"Always check agent status before delegating","teamMemberId":"crewly-orc"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `learning` | Yes | What you learned |
| `relatedTask` | No | Task this learning relates to |
| `relatedFiles` | No | Array of file paths related to the learning |
| `teamMemberId` | No | Your session name |
| `projectPath` | No | Current project path |

## Output

JSON confirmation with the stored learning entry ID.
