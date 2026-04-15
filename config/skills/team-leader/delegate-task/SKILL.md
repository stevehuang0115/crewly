---
name: Delegate Task (TL)
description: "Assign a task to a worker within the Team Leader's subordinate scope. Validates that the target worker's parentMemberId matches the TL's memberId before delegation. Includes auto-monitoring setup."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - delegate task
  - assign to worker
  - send task to worker
  - delegate to subordinate
tags:
  - task
  - delegation
  - management
  - hierarchy
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Delegate Task (TL Version)

Assigns a task to a worker within the Team Leader's subordinate scope. Validates hierarchy before delegation — the target worker's `parentMemberId` must match the TL's `memberId`.

## When to Use

- After `decompose-goal` creates sub-tasks
- When `handle-failure` decides to `reassign` a task
- When a new worker needs to be given work

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--to` / `-t` | `to` | Yes | Target worker's PTY session name |
| `--task` / `-T` | `task` | Yes | Task description (or pipe via stdin) |
| `--task-file` | — | No | Read task description from a file path |
| `--priority` / `-P` | `priority` | No | Priority: `low`, `normal`, `high` (default: `normal`) |
| `--context` / `-c` | `context` | No | Additional context for the worker |
| `--project` / `-p` | `projectPath` | No | Project path; creates task file in `.crewly/tasks/` |
| `--team` / `-g` | `teamId` | No | Team ID for hierarchy validation |
| `--tl-member` | `tlMemberId` | No | TL's member ID for hierarchy validation |
| `--from` | `fromSession` | No | Delegating TL's session name (for monitoring) |

## Usage — CLI Flags (preferred)

```bash
# Basic delegation
bash execute.sh --to worker-session --task "Implement login form" --priority high --project /path/to/project

# With hierarchy validation
bash execute.sh --to worker-session --task "Implement login form" --priority high --team team-123 --tl-member tl-member-id --project /path/to/project

# Task from stdin (for long descriptions with special characters)
echo "Implement the OAuth2 flow — it's critical for launch" | bash execute.sh --to worker-session --priority high --project /path

# Task from file
bash execute.sh --to worker-session --task-file /tmp/task-description.txt --priority high --project /path
```

## Usage — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"to":"worker-session","task":"Implement login form","priority":"high","teamId":"team-123","tlMemberId":"tl-member-id","projectPath":"/path/to/project"}'
```

## Hierarchy Validation

When `teamId` and `tlMemberId` are provided, the script fetches team data and validates:
- The target worker exists in the team
- The worker's `parentMemberId` matches the TL's `memberId`

If validation fails, delegation is rejected with a hierarchy violation error.

## Auto-Start Offline Workers

If the target worker is offline (delivery fails), the skill automatically:
1. Looks up the worker's `memberId` from team data
2. Calls `POST /teams/:teamId/members/:memberId/start` to boot the worker
3. Waits 10 seconds for the agent to initialize
4. Retries task delivery

This requires `--team` to be provided. Without team context, offline workers cannot be auto-started.

## Differences from Orchestrator delegate-task

| Aspect | Orchestrator | Team Leader |
|--------|-------------|-------------|
| Scope | Any agent in any team | Only subordinates |
| Message prefix | "New task from orchestrator" | "New task from Team Leader" |
| Hierarchy check | None | Validates parentMemberId |
| Monitoring subscriber | Orchestrator session | TL session |

## Output

JSON confirmation of task delivery, same format as orchestrator delegate-task.

## Related Skills

- `decompose-goal` — Create sub-tasks before delegating
- `verify-output` — Verify completed task output
- `handle-failure` — Handle delegation failures
