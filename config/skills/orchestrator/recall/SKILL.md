---
name: Recall
description: Retrieve relevant knowledge from memory based on context.
version: 1.0.0
category: memory
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - recall
  - remember what
  - check memory
tags:
  - memory
  - knowledge
  - retrieval
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Recall

Retrieve relevant knowledge from your persistent memory.

## Usage

```bash
bash config/skills/orchestrator/recall/execute.sh '{"context":"deployment process","scope":"both","teamMemberId":"crewly-orc"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `context` | Yes | What you're looking for or working on |
| `scope` | No | Scope: `agent`, `project`, or `both` (default: `both`) |
| `limit` | No | Maximum number of results |
| `teamMemberId` | No | Your session name |
| `projectPath` | No | Current project path |

## Output

JSON array of relevant knowledge entries sorted by relevance.
