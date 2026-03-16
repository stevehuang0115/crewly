---
name: Remember
description: Store knowledge in memory for future reference. Persists across sessions.
version: 1.0.0
category: memory
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - remember
  - store knowledge
  - save memory
tags:
  - memory
  - knowledge
  - persistence
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Remember

Store knowledge in your persistent memory for future reference.

## Usage

```bash
bash config/skills/orchestrator/remember/execute.sh '{"content":"TypeScript strict mode is required","category":"pattern","scope":"project","teamMemberId":"crewly-orc","projectPath":"/path/to/project"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `content` | Yes | The knowledge to store |
| `category` | Yes | See valid categories per scope below |
| `scope` | No | Scope: `agent` or `project` (default: `agent`) |
| `title` | No | Optional title for the knowledge |
| `teamMemberId` | No | Your session name |
| `projectPath` | No | Current project path |

## Valid Categories by Scope

- **Agent scope** (`scope: "agent"`): `fact`, `pattern`, `preference`
- **Project scope** (`scope: "project"`): `pattern`, `decision`, `gotcha`, `relationship`, `user_preference`

Using a category that doesn't match the scope will return an error.

## Output

JSON with the stored knowledge entry ID.
