---
name: Delegate Task
description: Create a WorkItem in the TaskPool targeting a specific agent. The Reconciler will automatically wake the agent and deliver the task when resources are available. No direct agent start or auto-monitoring — the Reconciler handles lifecycle, retries, and resource control.
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

Creates a WorkItem in the TaskPool targeting a specific agent. The Reconciler automatically detects the queued item, wakes the agent (respecting `maxConcurrentAgents` and memory limits), and the auto-claim service delivers the task.

The script auto-resolves `config/skills/...` references to absolute paths so delegated tasks remain runnable from any working directory.

**No auto-monitoring** — the Reconciler handles stuck/unclaimed WorkItem detection, agent lifecycle, and retries. No recurring checks or idle subscriptions are created.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--to` / `-t` | `to` | Yes | Target agent's PTY session name |
| `--task` / `-T` | `task` | Yes | Task description (or pipe via stdin) |
| `--task-file` | — | No | Read task description from a file path |
| `--priority` / `-P` | `priority` | No | Priority: `low`, `normal`, `high` (default: `normal`) |
| `--context` / `-c` | `context` | No | Additional context for the task. Scanned for the Request Contract alongside `--task` |
| `--project` / `-p` | `projectPath` | No | Project path; creates task file in `.crewly/tasks/` |
| `--team` / `-g` | `teamId` | No | Team ID for cross-team validation |
| `--task-type` | `taskType` | No | Task type: `general`, `technical` (default: `general`) |
| `--force-cross-team` | `forceCrossTeam` | No | Allow cross-team delegation |
| `--request-id` / `-R` | `requestId` | No | Ticket (Request) this work is for — the id or `TKT-123` from the `[TICKET:TKT-123 <id>]` line of the message you are acting on. Links the WorkItem into `Request.workItemIds[]`. Omit it and the WorkItem is still linked when your current turn has exactly one ticket |
| `--fallback-minutes` | — | No | Minutes until the ONE §3.0 fallback check fires for this delegation (default `120` ≈ 2× a TL milestone ETA). `0` disables it. Not cancelled on completion — keep it at 2× ETA, never a poll interval |

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

### With the fallback timer disabled (opt-out)

```bash
bash execute.sh --to agent-joe --task "Implement the login form" --priority high --project /path/to/project --fallback-minutes 0
```

## Examples

### Example 1: Basic delegation (one fallback timer by default)
```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-joe","task":"Fix the login bug","priority":"high"}'
```
This will automatically:
1. Create + claim the WorkItem in the task pool and deliver it to agent-joe's terminal
2. Schedule ONE fallback check (`fallbackTriggerId`, fires after `--fallback-minutes`, default 120) that wakes the orchestrator with a "Fallback check on agent-joe" WorkItem if the work is still open

It does NOT set up a recurring check — the reconciler escalates stalled or unverified work on its own. Add the `agent:idle_after_task` watch yourself per §3.0; never add a second fallback or a self-targeted "check on agent" WorkItem for the same delegation.

### Example 2: Delegation with project tracking
```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-joe","task":"Implement user auth","priority":"high","projectPath":"/path/to/project"}'
```
Also creates a task file in the project's `.crewly/tasks/` directory.

### Example 3: Cross-team delegation with a longer fallback (2× an 8 h ETA)
```bash
bash config/skills/orchestrator/delegate-task/execute.sh --to agent-sam --task "Ship the billing rewrite" --priority normal --fallback-minutes 720
```

### Example 4: Quick fix with the fallback disabled
```bash
bash config/skills/orchestrator/delegate-task/execute.sh --to agent-joe --task "Quick fix" --priority low --fallback-minutes 0
```

## Output

JSON confirmation of task delivery. When `projectPath` is provided, also returns the created task file path.

## Cleanup

The fallback trigger is **not** cancelled when the task completes. When it fires on already-verified work, complete the resulting check WorkItem immediately; to avoid the wake-up altogether, `cancel-followup --id <fallbackTriggerId from this skill's output>` once you have verified the deliverable (§3.0 step 3).

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
- `watch-for-event` — the `agent:idle_after_task` watch that completes the §3.0 loop (not created by this skill)
- `cancel-followup` — cancel the fallback trigger once the deliverable is verified
- `report-status` — agent reports completion, triggers auto-cleanup
