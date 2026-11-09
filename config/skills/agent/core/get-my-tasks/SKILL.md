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

Retrieve the tasks assigned to your current agent session. By default only **open** work comes back (queued, scheduled, proposed, accepted, running, blocked, escalated, done_by_worker, rejected); pass `--all` for finished tasks too. At startup your `## Your Active Work` section already has this — don't call it on top (#857).

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--session` / `-s` | `sessionName` | Yes | Your agent session name |
| `--project` / `-p` | `projectPath` | Yes | Absolute path to the current project |
| `--all` | `all` | No | Include finished tasks (verified / done / failed / cancelled) |

## Examples — CLI Flags (preferred)

```bash
bash config/skills/agent/core/get-my-tasks/execute.sh --session dev-1 --project /path/to/project
```

## Output

JSON array of tasks assigned to the session.
