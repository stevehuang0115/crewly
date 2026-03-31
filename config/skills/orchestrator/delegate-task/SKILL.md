---
name: Delegate Task
description: Send a structured task assignment to an agent with priority, context, and optional auto-monitoring. When monitor is provided, automatically subscribes to idle events and schedules fallback checks that are cleaned up on task completion. For formal task tracking, use assign-task instead. For simple messages, use send-message.
version: 2.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - delegate task
  - assign work
  - task agent
  - delegate with monitoring
  - send task to agent
tags:
  - task
  - delegation
  - management
  - monitoring
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Delegate Task

Sends a structured task assignment to an agent. When a `projectPath` is provided, also creates a task MD file in the project's `.crewly/tasks/delegated/in_progress/` directory for tracking.
The script auto-resolves `config/skills/...` references to absolute paths so delegated tasks remain runnable from any working directory.

**Monitoring is enabled by default** — idle event subscriptions and recurring fallback checks (every 5 minutes) are automatically set up for every delegation. These are linked to the task and will be **automatically cleaned up** when the task is completed via `report-status` or `complete-task`. To disable monitoring, explicitly pass `"monitor": {"idleEvent": false, "fallbackCheckMinutes": 0}`.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--to` / `-t` | `to` | Yes | Target agent's PTY session name |
| `--task` / `-T` | `task` | Yes | Task description (or pipe via stdin) |
| `--task-file` | — | No | Read task description from a file path |
| `--priority` / `-P` | `priority` | No | Priority: `low`, `normal`, `high` (default: `normal`) |
| `--context` / `-c` | `context` | No | Additional context for the task |
| `--project` / `-p` | `projectPath` | No | Project path; creates task file in `.crewly/tasks/` |
| `--team` / `-g` | `teamId` | No | Team ID for cross-team validation |
| `--task-type` | `taskType` | No | Task type: `general`, `technical` (default: `general`) |
| `--force-cross-team` | `forceCrossTeam` | No | Allow cross-team delegation |
| `monitor` (JSON only) | `monitor` | No | Auto-monitoring config (see below) |

## Usage — CLI Flags (preferred)

```bash
# Basic delegation
bash execute.sh --to agent-joe --task "Implement the login form" --priority high --project /path/to/project

# With context
bash execute.sh --to agent-joe --task "Implement login form" --priority high --context "Use React hooks" --project /path

# Task from stdin (for long descriptions with special characters)
echo "Implement the OAuth2 flow — it's critical for launch" | bash execute.sh --to agent-joe --priority high --project /path

# Task from file
bash execute.sh --to agent-joe --task-file /tmp/task-description.txt --priority high --project /path
```

## Usage — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"to":"agent-joe","task":"Implement the login form","priority":"high","context":"Use React hooks","projectPath":"/path/to/project"}'
```

### With monitoring disabled (opt-out, JSON only)

```bash
bash execute.sh '{"to":"agent-joe","task":"Implement the login form","priority":"high","projectPath":"/path/to/project","monitor":{"idleEvent":false,"fallbackCheckMinutes":0}}'
```

## Examples

### Example 1: Basic delegation (monitoring enabled by default)
```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-joe","task":"Fix the login bug","priority":"high"}'
```
This will automatically:
1. Send the task to agent-joe's terminal
2. Subscribe to `agent:idle` for agent-joe (auto-notifies when agent goes idle)
3. Schedule a recurring check every 5 minutes (auto-reminds orchestrator to check progress)
4. Link all monitoring IDs to the task for auto-cleanup on completion

### Example 2: Delegation with project tracking + monitoring
```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-joe","task":"Implement user auth","priority":"high","projectPath":"/path/to/project"}'
```
Also creates a task file in the project's `.crewly/tasks/` directory.

### Example 3: Delegation with custom monitoring interval
```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-sam","task":"Write unit tests","priority":"normal","monitor":{"fallbackCheckMinutes":10}}'
```

### Example 4: Delegation with monitoring disabled
```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-joe","task":"Quick fix","priority":"low","monitor":{"idleEvent":false,"fallbackCheckMinutes":0}}'
```

## Output

JSON confirmation of task delivery. When `projectPath` is provided, also returns the created task file path.

## Auto-Cleanup

When the agent completes the task (via `report-status` with `status: done` or `complete-task`), all linked monitoring is automatically cleaned up:
- Scheduled checks are cancelled
- Event subscriptions are unsubscribed

No manual cleanup needed.

## Delivery Strategy

The script uses a two-stage delivery strategy:

1. **Reliable delivery** (15s timeout) — Waits for the agent to be at a prompt, then delivers with verification. This is the preferred path.
2. **Force fallback** — If the agent is busy or not ready within 15 seconds, the message is written directly to the PTY session without waiting. The task is still delivered, but may appear mid-output.

This ensures tasks are always delivered even when agents are busy processing previous work.

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required parameter: to` | `to` not provided | Include target session name |
| `Missing required parameter: task` | `task` not provided | Include task description |
| `Failed to deliver task to X` | Session doesn't exist or agent crashed | Check agent status, restart if needed |
| `curl failed with exit code N` | Backend not running | Start the Crewly backend |

Error messages are output to **stdout** (JSON format) so the orchestrator can read them. Monitoring setup failures are non-fatal — if subscribe-event or schedule-check fails, the task is still delegated successfully.

## Related Skills

- `assign-task` — for formal task tracking in the management system (file-based kanban)
- `send-message` — for simple messages without task structure
- `subscribe-event` — manual event subscription (auto-handled when using `monitor`)
- `schedule-check` — manual schedule creation (auto-handled when using `monitor`)
- `report-status` — agent reports completion, triggers auto-cleanup
