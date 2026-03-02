# Delegate Task

Sends a structured task assignment to an agent. When a `projectPath` is provided, also creates a task MD file in the project's `.crewly/tasks/delegated/in_progress/` directory for tracking.
The script auto-resolves `config/skills/...` references to absolute paths so delegated tasks remain runnable from any working directory.

**Monitoring is enabled by default** — idle event subscriptions and recurring fallback checks (every 5 minutes) are automatically set up for every delegation. These are linked to the task and will be **automatically cleaned up** when the task is completed via `report-status` or `complete-task`. To disable monitoring, explicitly pass `"monitor": {"idleEvent": false, "fallbackCheckMinutes": 0}`.

## Usage

```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-joe","task":"Implement the login form","priority":"high","context":"Use React hooks","projectPath":"/path/to/project"}'
```

### With monitoring disabled (opt-out)

```bash
bash config/skills/orchestrator/delegate-task/execute.sh '{"to":"agent-joe","task":"Implement the login form","priority":"high","projectPath":"/path/to/project","monitor":{"idleEvent":false,"fallbackCheckMinutes":0}}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `to` | Yes | Target agent's PTY session name |
| `task` | Yes | Task description |
| `priority` | No | Task priority: `low`, `normal`, `high` (default: `normal`) |
| `context` | No | Additional context for the task |
| `projectPath` | No | Project path; when provided, creates a task MD file in `.crewly/tasks/` |
| `monitor` | No | Auto-monitoring configuration (see below). Enabled by default. |
| `monitor.idleEvent` | No | If `true`, subscribes to `agent:idle` event for the target agent (default: `true`) |
| `monitor.fallbackCheckMinutes` | No | If > 0, sets up a recurring fallback check every N minutes (default: `5`) |

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

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required parameter: to` | `to` not provided | Include target session name |
| `Missing required parameter: task` | `task` not provided | Include task description |
| `curl failed with exit code N` | Backend not running | Start the Crewly backend |

Monitoring setup failures are non-fatal — if subscribe-event or schedule-check fails, the task is still delegated successfully.

## Related Skills

- `assign-task` — for formal task tracking in the management system (file-based kanban)
- `send-message` — for simple messages without task structure
- `subscribe-event` — manual event subscription (auto-handled when using `monitor`)
- `schedule-check` — manual schedule creation (auto-handled when using `monitor`)
- `report-status` — agent reports completion, triggers auto-cleanup
