---
name: Decompose Mission
description: Break a Mission (OKR/objective) into concrete, executable tasks with dependencies. The runtime does the thinking — this skill provides context (Mission objective, team capabilities, success criteria) and collects the structured output. Supports progressive decomposition (Phase N only).
version: 1.0.0
category: planning
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
triggers:
  - decompose mission
  - break down objective
  - plan mission tasks
  - mission decomposition
tags:
  - mission
  - planning
  - decomposition
  - autonomous
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Decompose Mission

Decomposes a Mission objective into concrete, executable tasks (WorkItems) with
dependency relationships. The agent runtime does the thinking — this skill
assembles context and submits the structured result to the backend.

## Usage

```bash
bash config/skills/orchestrator/decompose-mission/execute.sh \
  --mission-id <uuid> \
  --project-path /path/to/project \
  [--phase <number>]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--mission-id` | Yes | UUID of the Mission to decompose |
| `--project-path` | Yes | Absolute path to the project root |
| `--phase` | No | Phase number to decompose (default: 1). Use for progressive decomposition. |

## Output

The skill instructs the runtime to output JSON matching:

```json
{
  "phases": [
    {
      "phaseNumber": 1,
      "name": "Phase name",
      "tasks": [
        {
          "title": "Task title",
          "description": "What to do",
          "type": "delegate",
          "priority": "high",
          "suggestedRole": "developer",
          "estimatedMinutes": 60,
          "dependsOn": []
        }
      ]
    }
  ]
}
```

The skill then POSTs this to `POST /api/missions/:id/decompose` which creates
WorkItems in the TaskPool with appropriate `_blockedBy` metadata.
