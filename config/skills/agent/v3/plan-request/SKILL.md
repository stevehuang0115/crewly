---
name: Plan Request
description: "Analyze a user request and get a list of proposed ProjectTasks via the V3 Request Plan API."
version: 1.0.0
category: planning
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
  - plan request
  - decompose request
  - analyze request
  - plan tasks
tags:
  - v3
  - request
  - planning
  - decomposition
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Plan Request

Analyze a user request message and get a list of proposed ProjectTasks via the `POST /api/requests/plan` endpoint. This allows agents (orchestrator or sub-agents) to decompose a user request into structured, actionable tasks.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--message` / `-m` | `message` | Yes | The user request message to decompose |
| `--max-tasks` | `options.maxTasks` | No | Maximum number of tasks to generate |
| `--default-priority` | `options.defaultPriority` | No | Default priority for tasks: `high`, `medium`, `low` |

## Examples — CLI Flags (preferred)

```bash
# Basic plan
bash execute.sh --message "Build a new authentication system with OAuth2 support"

# Plan with options
bash execute.sh --message "Fix all failing tests in the auth module" \
  --max-tasks 10 --default-priority high
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"message":"Build a search feature","options":{"maxTasks":5,"defaultPriority":"medium"}}'
```

## Output

JSON response with a `RequestPlan` containing:
- `message` — The original user message
- `tasks` — Array of proposed tasks with title, description, acceptance criteria, and priority
- `reasoning` — Human-readable explanation of the decomposition
- `strategy` — Which planning strategy was applied (`build`, `fix`, `generic`, `none`)
