---
name: Design Team
description: "Create a new team from a natural language description. The runtime analyzes the request, selects or designs the appropriate team structure (roles, hierarchy, ownership, service contract), and outputs a structured team config that the backend uses to create the team."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - design team
  - create team
  - build team
  - set up a team
  - new team for
tags:
  - team
  - organization
  - design
  - creation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Design Team

Creates a team from a natural language description (e.g., "帮我建一个做前端的团队，3个人").
The runtime does the reasoning — this skill provides context (available templates, roles, existing teams)
and collects the structured output.

## Usage

```bash
bash config/skills/orchestrator/design-team/execute.sh \
  --description "Build a frontend team with 3 people" \
  --project-path /path/to/project
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--description` | Yes | Natural language team description |
| `--project-path` | No | Project path to assign |

## Output

Runtime generates a team config JSON, then submits via API to create the team.
