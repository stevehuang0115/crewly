---
name: broadcast
description: "Send a message to all active agent sessions, excluding the orchestrator. Use when the orchestrator needs to announce information or coordinate the entire team at once. For messaging a single agent, use send-message instead."
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - broadcast
  - message all
  - announce
tags:
  - communication
  - broadcast
  - team
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Broadcast

Send a message to all active agent sessions. The skill queries active sessions from the backend, skips the orchestrator's own session (`crewly-orc`), and delivers the message to each remaining agent individually.

## When to Use

Run this skill when the orchestrator needs to announce information, coordinate timing, or send instructions to the entire team at once. Each agent receives the message in their terminal session via the delivery endpoint.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `message` | Yes | The message text to broadcast to all agents |

## Examples

### Announce a team standup

```bash
bash config/skills/orchestrator/broadcast/execute.sh '{"message":"Team standup in 5 minutes"}'
```

### Send a priority directive

```bash
bash config/skills/orchestrator/broadcast/execute.sh '{"message":"Priority shift: all agents focus on bug fixes for the next sprint"}'
```

## Output

```json
{
  "sent": 3,
  "failed": 0,
  "message": "Broadcast complete"
}
```

- `sent` — number of agents that received the message
- `failed` — number of delivery failures
- `message` — status summary

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required parameter: message` | `message` not provided in JSON input | Include `message` in the JSON payload |
| `Failed to get sessions` | Backend not reachable or sessions endpoint failed | Verify the Crewly backend is running |
| `curl failed with exit code N` | Network issue or backend down | Check backend health at `CREWLY_API_URL/api/health` |
| High `failed` count | One or more agent sessions are unresponsive | Check agent status with `get-team-status` and restart failed agents |

## Related Skills

- `send-message` — send a message to a single agent session
- `get-team-status` — check which agents are active before broadcasting
- `delegate-task` — send a task (not just a message) to a specific agent
