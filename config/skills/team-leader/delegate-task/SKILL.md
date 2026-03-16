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

## Usage

```bash
bash {{SKILLS_PATH}}/team-leader/delegate-task/execute.sh '{"to":"worker-session","task":"Implement login form","priority":"high","teamId":"team-123","tlMemberId":"tl-member-id","projectPath":"/path/to/project"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `to` | Yes | Target worker's PTY session name |
| `task` | Yes | Task description (skill paths auto-resolved to absolute) |
| `priority` | No | Task priority: `low`, `normal`, `high` (default: `normal`) |
| `context` | No | Additional context for the worker |
| `teamId` | No | Team ID for hierarchy validation |
| `tlMemberId` | No | TL's member ID for hierarchy validation |
| `projectPath` | No | Project path; creates task file in `.crewly/tasks/` |
| `monitor` | No | Auto-monitoring config (same as orchestrator delegate-task) |

## Hierarchy Validation

When `teamId` and `tlMemberId` are provided, the script fetches team data and validates:
- The target worker exists in the team
- The worker's `parentMemberId` matches the TL's `memberId`

If validation fails, delegation is rejected with a hierarchy violation error.

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
