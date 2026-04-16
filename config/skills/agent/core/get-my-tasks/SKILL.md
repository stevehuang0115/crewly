---
name: Get My Tasks
description: Retrieve all tasks assigned to your current agent session for a specific project.
natural_language_description: List all tasks currently assigned to you, including their status and file paths.
version: 1.0.0
category: task-management
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
triggers:
  - get tasks
  - my tasks
  - what should I do
  - check tasks
tags:
  - task
  - list
  - assignment
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get My Tasks

Retrieve all tasks assigned to your current agent session for a specific project. This includes tasks in `open`, `in_progress`, and `done` states.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--session` / `-s` | `sessionName` | Yes | Your agent session name |
| `--project` / `-p` | `projectPath` | Yes | Absolute path to the current project |

## Examples — CLI Flags (preferred)

```bash
bash config/skills/agent/core/get-my-tasks/execute.sh --session dev-1 --project /path/to/project
```

## Output

JSON array of tasks assigned to the session.
