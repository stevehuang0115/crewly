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
| `--owner` | `owner` | No | Responsible role: `orchestrator`, `team_lead`, `agent` (default), `system`. A role, not a session name — use `--session` for the session |
| `--description` / `-d` | `description` | No | Short summary of the task |
| `--brief` | `briefMarkdown` | No | Long-form brief in markdown. Inline text, or `@/path/to/file.md`. Max 16384 bytes |

### Always attach a brief

A task's title is not a contract. Every delegated task should carry **Goal**, **Expected Outcome**, and **Eval Criteria**
— the receiving agent is expected to ask for them if they are missing, and a task without them tends to drift or come
back unsatisfiable.

Put them in `--brief`. Prefer the `@file` form: a real brief is usually too long, and too full of quotes and backticks,
to survive being passed as a shell argument.

```bash
cat > /tmp/brief.md <<'EOF'
## GOAL
What the user ultimately wants.

## EXPECTED OUTCOME
What must be true when this is done.

## EVAL CRITERIA
1. Testable statement.
2. Another one.
EOF

bash execute.sh --project-path /path/to/project --task "Implement login API" \
  --description "Session-cookie auth for the web portal" \
  --brief @/tmp/brief.md --session dev-max
```

An over-limit brief is **rejected, never truncated** — the error names the limit and your actual size, because what to
cut is your call, not the tool's.

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
