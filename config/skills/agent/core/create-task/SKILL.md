---
name: Create Task
description: "Create a new task via the task-management API for autonomous work decomposition."
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
triggers:
  - create task
  - new task
  - add task
  - decompose task
  - sub-task
tags:
  - task
  - management
  - decomposition
  - delegation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Create Task

Create a new task via the `/api/task-management/create` endpoint. This allows team leads and agents to autonomously decompose their work into sub-tasks without requiring orchestrator intervention.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--project-path` / `-p` | `projectPath` | Yes | Absolute path to the project root |
| `--task` / `-t` | `task` | Yes | Task description |
| `--priority` | `priority` | No | Priority: `low`, `medium` (default), `high`, `critical` |
| `--milestone` / `-m` | `milestone` | No | Milestone/sprint name (default: `delegated`) |
| `--session` / `-s` | `sessionName` | No | Session to assign the task to (open if omitted) |
| `--output-schema` | `outputSchema` | No | JSON object defining expected output schema |

## Examples — CLI Flags (preferred)

```bash
# Create an open task
bash execute.sh --project-path /path/to/project --task "Implement login API endpoint"

# Create and assign to a specific agent
bash execute.sh --project-path /path/to/project --task "Write unit tests for auth service" \
  --priority high --milestone sprint-2 --session dev-max

# Create with output schema
bash execute.sh --project-path /path/to/project --task "Generate API report" \
  --output-schema '{"type":"object","properties":{"report":{"type":"string"}}}'
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"projectPath":"/path/to/project","task":"Implement login API","priority":"high","milestone":"sprint-1"}'
```

## Output

JSON response from the task-management API confirming task creation, including the task file path and metadata.
