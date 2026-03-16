---
name: Create Project
description: Create a new project in Crewly with a path, name, and description.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - create project
  - new project
  - set up project
tags:
  - project
  - management
  - creation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Create Project

Creates a new project in Crewly with a specified filesystem path, display name, and optional description.

## Usage

```bash
bash config/skills/orchestrator/create-project/execute.sh '{"path":"/absolute/path/to/project","name":"My Project","description":"A web application"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Absolute filesystem path to the project directory |
| `name` | No | Human-readable project name |
| `description` | No | Brief description of the project |

## Output

JSON with the created project details including project ID.
